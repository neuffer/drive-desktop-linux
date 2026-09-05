import { logger } from '@internxt/drive-desktop-core/build/backend';
import eventBus from '../event-bus';
import { areRemoteNotificationsEnabled } from '../realtime';
import { remoteSyncManager, startRemoteSync } from './service';

// A periodic fallback for the case where remote notifications are disabled and
// nothing else asks for a sync on a timer. It runs only while they are off.
//
// The interval is a placeholder for the vendor to set. A tick is not free:
// `getFileCheckpoint` rewinds the newest local `updatedAt` by six hours, so each
// one re-fetches whatever falls in that window.
const FALLBACK_POLL_INTERVAL_MS = 15 * 60 * 1000;

// Consecutive failures back off rather than hammering a server that is already
// unhappy, and a long outage settles at the cap instead of retrying 96 times a
// day. Reset on the first success.
const FALLBACK_POLL_MAX_INTERVAL_MS = 60 * 60 * 1000;
const FALLBACK_POLL_BACKOFF_FACTOR = 2;

// Every client would otherwise poll on a period anchored to its own start, and
// clients started together (a fleet update, a power cut, an office arriving in
// the morning) would stay in step indefinitely. Jitter is applied per tick
// rather than once, so runs spread out instead of holding a fixed offset.
const FALLBACK_POLL_JITTER = 0.2;

let timer: NodeJS.Timeout | undefined;
let running = false;
let consecutiveFailures = 0;

// `running` alone cannot tell one polling lifetime from the next. A tick that is
// still in flight when the poll is stopped and started again would see
// `running === true` on completion and schedule a second chain alongside the new
// one, and only the newest timer is tracked, so the older chain could never be
// stopped. Each lifetime gets a number, a tick captures it, and a tick may only
// schedule work for the lifetime it belongs to.
let generation = 0;

function nextDelay(): number {
  const backoff = Math.min(
    FALLBACK_POLL_INTERVAL_MS * FALLBACK_POLL_BACKOFF_FACTOR ** consecutiveFailures,
    FALLBACK_POLL_MAX_INTERVAL_MS,
  );
  const spread = backoff * FALLBACK_POLL_JITTER;
  const jittered = backoff - spread + Math.random() * 2 * spread;

  // Capped AFTER the jitter, so the maximum really is the maximum. Capping only
  // the base would leave the true ceiling 20% above the stated one.
  return Math.round(Math.min(jittered, FALLBACK_POLL_MAX_INTERVAL_MS));
}

/**
 * Runs one poll.
 *
 * @param forGeneration the polling lifetime this tick belongs to. Checked again
 * after the await: the session can end while a sync is in flight, and work
 * announced into the next session is worse than work not done.
 * @returns whether this call's own sync completed. Not the same as whether it
 * threw: `RemoteSyncManager.startRemoteSync` catches its own failures and
 * resolves, and it also declines to start at all when a sync is already running,
 * so neither a rejection nor the absence of one says what happened.
 */
async function tick(forGeneration: number): Promise<boolean> {
  // The manager's own `smokeTest` already refuses to start while a sync is
  // running, so this is not the guard that protects it. It skips the pointless
  // call and the warning it would log.
  if (remoteSyncManager.getSyncStatus() === 'SYNCING') {
    logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] A sync is already running, skipping this tick' });
    return true;
  }

  logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Checking for remote changes' });

  await startRemoteSync();

  if (!running || forGeneration !== generation) {
    logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] The session ended during this tick, not announcing' });
    return true;
  }

  // Positively require SYNCED rather than merely excluding SYNC_FAILED. The
  // pre-check above and this call are not atomic, so another trigger can start a
  // sync in between; `smokeTest` then declines this one and the status is still
  // SYNCING. Excluding only SYNC_FAILED would announce a sync that never ran.
  if (remoteSyncManager.getSyncStatus() !== 'SYNCED') {
    logger.warn({
      tag: 'SYNC-ENGINE',
      msg: '[Fallback poll] The sync did not complete, not announcing remote changes',
      status: remoteSyncManager.getSyncStatus(),
    });
    return false;
  }

  // Both halves, as the manual sync button does: `startRemoteSync` refreshes the
  // local database, and this event is what consumers rebuild from.
  eventBus.emit('REMOTE_CHANGES_SYNCHED');
  return true;
}

function scheduleNext(forGeneration: number): void {
  timer = setTimeout(() => {
    if (!running || forGeneration !== generation) {
      return;
    }

    // Checked before the tick rather than after it, so turning notifications on
    // does not cost one further sync first. The flag is a build-time constant
    // today, so this is a cheap guard rather than a supported runtime
    // transition.
    if (areRemoteNotificationsEnabled()) {
      logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Remote notifications are enabled, stopping' });
      stopFallbackSyncPoll();
      return;
    }

    // The next tick is scheduled only after this one has finished, so a slow or
    // failing sync cannot stack ticks the way a fixed interval would.
    void tick(forGeneration)
      .then((succeeded) => {
        // Only this lifetime's own result may move its backoff. A tick left over
        // from a previous session must not make the current one back off.
        if (forGeneration === generation) {
          consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
        }
      })
      .catch((error) => {
        // A failed poll must never end the polling: the next remote change would
        // then be invisible until a restart, which is the condition this exists
        // to remove.
        if (forGeneration === generation) {
          consecutiveFailures += 1;
        }
        logger.error({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Sync failed, will try again', error });
      })
      .finally(() => {
        // A tick belonging to a previous lifetime must not schedule anything,
        // even though it is only finishing now. This is the cheap early-out; the
        // check at the top of the callback is what actually enforces it, and
        // either alone is sufficient.
        if (running && forGeneration === generation) {
          scheduleNext(forGeneration);
        }
      });
  }, nextDelay());

  // The pending timer must not be a reason for the Electron main process to stay
  // alive when the application is quitting.
  timer.unref?.();
}

/**
 * Starts the periodic fallback sync, if it is needed and not already running.
 *
 * Does nothing when remote notifications are enabled, because the socket is then
 * the continuous path this stands in for. Calling it twice does not start two
 * loops.
 */
export function startFallbackSyncPoll(): void {
  if (areRemoteNotificationsEnabled()) {
    logger.debug({
      tag: 'SYNC-ENGINE',
      msg: '[Fallback poll] Remote notifications are enabled, no fallback needed',
    });
    return;
  }

  if (running) {
    return;
  }

  running = true;
  consecutiveFailures = 0;
  generation += 1;
  scheduleNext(generation);
}

/** Stops the periodic fallback sync. Safe to call when it is not running. */
export function stopFallbackSyncPoll(): void {
  running = false;

  // Retires any tick that is still in flight, so that it cannot schedule work
  // into a lifetime that has ended.
  generation += 1;

  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}
