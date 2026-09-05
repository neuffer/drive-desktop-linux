import { app, ipcMain } from 'electron';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import eventBus from '../event-bus';
import { setInitialSyncState } from './InitialSyncReady';
import { remoteSyncManager, resyncRemoteSync, startRemoteSync } from './service';
import { startFallbackSyncPoll, stopFallbackSyncPoll } from './fallback-sync-poll';

ipcMain.handle('START_REMOTE_SYNC', async () => {
  await startRemoteSync();
  eventBus.emit('REMOTE_CHANGES_SYNCHED');
});

ipcMain.handle('get-remote-sync-status', () => remoteSyncManager.getSyncStatus());

eventBus.on('RECEIVED_REMOTE_CHANGES', async () => {
  // Wait before checking for updates, could be possible
  // that we received the notification, but if we check
  // for new data we don't receive it
  await resyncRemoteSync();
});

eventBus.on('APP_DATA_SOURCE_INITIALIZED', async () => {
  await remoteSyncManager.startRemoteSync().catch((error) => {
    logger.error({
      tag: 'SYNC-ENGINE',
      msg: 'Error starting remote sync manager',
      error,
    });
  });
});

// Not APP_DATA_SOURCE_INITIALIZED, which is where this began: that event is
// emitted inside `if (!AppDataSource.isInitialized)`, so it fires at most once
// per process. Starting the poll there meant that the first logout stopped it
// for good, because logging back in re-runs `onUserLoggedIn` without
// re-initialising the data source. USER_LOGGED_IN is per session, which is what
// the poll's lifetime should follow.
eventBus.on('USER_LOGGED_IN', () => {
  startFallbackSyncPoll();
});

eventBus.on('USER_LOGGED_OUT', () => {
  setInitialSyncState('NOT_READY');
  stopFallbackSyncPoll();
  remoteSyncManager.resetRemoteSync();
});

app.on('before-quit', () => {
  stopFallbackSyncPoll();
});
