vi.mock('@internxt/drive-desktop-core/build/backend');
vi.mock('../realtime', () => ({ areRemoteNotificationsEnabled: vi.fn() }));
vi.mock('./service', () => ({
  startRemoteSync: vi.fn(),
  remoteSyncManager: { getSyncStatus: vi.fn() },
}));
vi.mock('../event-bus', () => ({ default: { emit: vi.fn() } }));

import eventBus from '../event-bus';
import { areRemoteNotificationsEnabled } from '../realtime';
import { remoteSyncManager, startRemoteSync } from './service';
import { startFallbackSyncPoll, stopFallbackSyncPoll } from './fallback-sync-poll';

const notificationsEnabled = vi.mocked(areRemoteNotificationsEnabled);
const syncStatus = vi.mocked(remoteSyncManager.getSyncStatus);
const sync = vi.mocked(startRemoteSync);
const emit = vi.mocked(eventBus.emit);

const INTERVAL_MS = 5 * 60 * 1000;
// One tick can be scheduled anywhere in [interval - 20%, interval + 20%], so
// advancing by the upper bound guarantees exactly one has fired.
const PAST_ONE_TICK = INTERVAL_MS * 1.2;

/** Lets the tick's promise chain settle between fake-timer advances. */
async function settle() {
  await vi.advanceTimersByTimeAsync(PAST_ONE_TICK);
}

describe('fallback sync poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    notificationsEnabled.mockReturnValue(false);
    syncStatus.mockReturnValue('IDLE');
    sync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopFallbackSyncPoll();
    vi.useRealTimers();
  });

  it('does not poll at all when remote notifications are enabled', async () => {
    notificationsEnabled.mockReturnValue(true);

    startFallbackSyncPoll();
    await settle();

    expect(sync).not.toHaveBeenCalled();
  });

  it('syncs and publishes the event, because the database alone does not refresh the mounted tree', async () => {
    startFallbackSyncPoll();
    await settle();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('REMOTE_CHANGES_SYNCHED');
  });

  it('keeps polling after a tick', async () => {
    startFallbackSyncPoll();
    await settle();
    await settle();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('keeps polling after a tick that failed, or the next change is invisible until a restart', async () => {
    sync.mockRejectedValueOnce(new Error('network down'));

    startFallbackSyncPoll();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);

    await settle();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while a sync is already running', async () => {
    syncStatus.mockReturnValue('SYNCING');

    startFallbackSyncPoll();
    await settle();

    expect(sync).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('resumes after the running sync finishes', async () => {
    syncStatus.mockReturnValue('SYNCING');
    startFallbackSyncPoll();
    await settle();
    expect(sync).not.toHaveBeenCalled();

    syncStatus.mockReturnValue('SYNCED');
    await settle();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('stops when asked, and a stop during a tick is not undone by that tick', async () => {
    startFallbackSyncPoll();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);

    stopFallbackSyncPoll();
    await settle();
    await settle();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start a second loop when started twice', async () => {
    startFallbackSyncPoll();
    startFallbackSyncPoll();
    await settle();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('retires itself if notifications are turned on later', async () => {
    startFallbackSyncPoll();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);

    notificationsEnabled.mockReturnValue(true);
    await settle();
    await settle();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('spreads the interval, so clients started together do not stay in step', async () => {
    const delays: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const random = vi.spyOn(Math, 'random');

    random.mockReturnValue(0);
    startFallbackSyncPoll();
    stopFallbackSyncPoll();

    random.mockReturnValue(1);
    startFallbackSyncPoll();
    stopFallbackSyncPoll();

    expect(delays).toEqual([INTERVAL_MS * 0.8, INTERVAL_MS * 1.2]);

    spy.mockRestore();
    random.mockRestore();
  });
});
