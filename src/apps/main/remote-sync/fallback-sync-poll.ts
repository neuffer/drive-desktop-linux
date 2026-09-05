import { logger } from '@internxt/drive-desktop-core/build/backend';
import eventBus from '../event-bus';
import { areRemoteNotificationsEnabled } from '../realtime';
import { remoteSyncManager, startRemoteSync } from './service';

// Remote notifications are the client's only continuous path to remote state,
// and they are switched off (`remoteNotificationsEnabled`, realtime.ts). With
// them off, `startRemoteSync` is reached only from application start, a local
// override, and the user pressing sync, so a file changed on another device is
// invisible until one of those happens. On a machine where nobody is editing
// files on the drive, that can be days.
//
// This is the fallback that was missing, not a replacement for notifications:
// it runs only while they are disabled, so re-enabling the socket makes it stop
// starting.
//
// The interval is a placeholder and the vendor should choose it. A tick is not
// free and is not a no-op either: `getFileCheckpoint` rewinds the newest local
// `updatedAt` by six hours, so every tick re-fetches and re-upserts whatever
// falls in that window. Measured on one real account that is 3 files and 3
// folders, two requests; after a bulk upload it is however much of that upload
// lands in six hours, paginated 1000 at a time, until newer activity moves the
// window past it.
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

  // Uniform in [backoff - spread, backoff + spread].
  return Math.round(backoff - spread + Math.random() * 2 * spread);
}

/**
 * Runs one poll.
 *
 * @returns whether the sync actually succeeded, which is not the same as whether
 * it threw. `RemoteSyncManager.startRemoteSync` catches its own failures and
 * resolves normally, leaving the outcome in the manager's status, so a caller
 * that only watches for a rejection would treat a failed sync as a good one.
 */
async function tick(): Promise<boolean> {
  // The manager's own `smokeTest` already refuses to start while a sync is
  // running, so this is not the guard that protects it. It is here to skip the
  // pointless call and the warning it would log.
  if (remoteSyncManager.getSyncStatus() === 'SYNCING') {
    logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] A sync is already running, skipping this tick' });
    return true;
  }

  logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Checking for remote changes' });

  await startRemoteSync();

  if (remoteSyncManager.getSyncStatus() === 'SYNC_FAILED') {
    logger.warn({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] The sync failed, not announcing remote changes' });
    return false;
  }

  // Both halves, exactly as the manual sync button does: `startRemoteSync`
  // refreshes the local database, and this event is what consumers listen to in
  // order to rebuild from it. Announcing after a failed sync would have them
  // rebuild from contents that were never refreshed.
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
    void tick()
      .then((succeeded) => {
        consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      })
      .catch((error) => {
        // A failed poll must never end the polling: the next remote change would
        // then be invisible until a restart, which is the condition this exists
        // to remove.
        consecutiveFailures += 1;
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
