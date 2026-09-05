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
// it runs ONLY while they are disabled and retires itself if they are ever
// turned back on, so re-enabling them removes the polling without a second
// change.
const FALLBACK_POLL_INTERVAL_MS = 5 * 60 * 1000;

// Every client would otherwise poll on a period anchored to its own start, and
// clients started together (a fleet update, a power cut, an office arriving in
// the morning) would stay in step indefinitely. Jitter is applied per tick
// rather than once, so runs spread out instead of holding a fixed offset.
const FALLBACK_POLL_JITTER = 0.2;

let timer: NodeJS.Timeout | undefined;
let running = false;

function nextDelay(): number {
  const spread = FALLBACK_POLL_INTERVAL_MS * FALLBACK_POLL_JITTER;

  // Uniform in [interval - spread, interval + spread].
  return Math.round(FALLBACK_POLL_INTERVAL_MS - spread + Math.random() * 2 * spread);
}

async function tick(): Promise<void> {
  // A sync that is still running is already doing the work this tick would ask
  // for, and starting a second one resets the manager's counters underneath it.
  if (remoteSyncManager.getSyncStatus() === 'SYNCING') {
    logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] A sync is already running, skipping this tick' });
    return;
  }

  logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Checking for remote changes' });

  await startRemoteSync();

  // Both halves, exactly as the manual sync button does: `startRemoteSync`
  // refreshes the local database, and this event is what rebuilds the virtual
  // drive's in-memory tree from it. Without the event the poll would update the
  // database while the mounted drive still showed the old tree.
  eventBus.emit('REMOTE_CHANGES_SYNCHED');
}

function scheduleNext(): void {
  timer = setTimeout(() => {
    if (!running) {
      return;
    }

    // Checked here, before the tick rather than after it, so that enabling
    // notifications retires the poll at the next tick boundary WITHOUT running
    // one more sync first. Checking per tick rather than only at start is what
    // lets it retire without a restart.
    if (areRemoteNotificationsEnabled()) {
      logger.debug({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Remote notifications are on again, stopping' });
      stopFallbackSyncPoll();
      return;
    }

    // The next tick is scheduled only after this one has finished, so a slow or
    // failing sync cannot stack ticks the way a fixed interval would.
    void tick()
      .catch((error) => {
        // A failed poll must never end the polling: the next remote change would
        // then be invisible until a restart, which is the condition this exists
        // to remove.
        logger.error({ tag: 'SYNC-ENGINE', msg: '[Fallback poll] Sync failed, will try again', error });
      })
      .finally(() => {
        if (running) {
          scheduleNext();
        }
      });
  }, nextDelay());
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
  scheduleNext();
}

/** Stops the periodic fallback sync. Safe to call when it is not running. */
export function stopFallbackSyncPoll(): void {
  running = false;

  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}
