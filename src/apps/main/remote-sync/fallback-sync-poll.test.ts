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

const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Runs the next scheduled timeout and lets its promise chain settle.
 *
 * `advanceTimersToNextTimerAsync` rather than advancing by a duration: each
 * delay is jittered, and advancing by a fixed span could cross two deadlines and
 * make the call counts depend on which random values came up.
 */
async function nextTick() {
  await vi.advanceTimersToNextTimerAsync();
}

/** A promise whose resolution this test controls, to hold a tick in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('fallback sync poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Pinned so behavioural tests do not depend on which jitter came up. The
    // jitter itself is asserted separately.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    notificationsEnabled.mockReturnValue(false);
    syncStatus.mockReturnValue('SYNCED');
    sync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopFallbackSyncPoll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not poll at all when remote notifications are enabled', async () => {
    notificationsEnabled.mockReturnValue(true);

    startFallbackSyncPoll();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(sync).not.toHaveBeenCalled();
  });

  it('syncs and announces, because consumers rebuild from the event and not from the sync', async () => {
    startFallbackSyncPoll();
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('REMOTE_CHANGES_SYNCHED');
  });

  it('keeps polling after a tick', async () => {
    startFallbackSyncPoll();
    await nextTick();
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does NOT announce a sync that failed without throwing', async () => {
    // startRemoteSync catches its own failures and resolves, leaving the outcome
    // in the manager's status. A poll that only watched for a rejection would
    // announce this one as a success and have consumers rebuild from contents
    // that were never refreshed.
    syncStatus.mockReturnValue('SYNC_FAILED');

    startFallbackSyncPoll();
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps polling after a tick that threw', async () => {
    sync.mockRejectedValueOnce(new Error('database is not connected'));

    startFallbackSyncPoll();
    await nextTick();
    expect(sync).toHaveBeenCalledTimes(1);

    await nextTick();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('backs off while syncs keep failing, and recovers the base interval after one succeeds', async () => {
    // Delegates to the (fake) timer rather than replacing it, so the poll chain
    // keeps running while the delays are recorded.
    const scheduled = global.setTimeout;
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return scheduled(fn, ms);
    }) as unknown as typeof setTimeout);

    syncStatus.mockReturnValue('SYNC_FAILED');
    startFallbackSyncPoll();

    await nextTick();
    await nextTick();
    await nextTick();
    syncStatus.mockReturnValue('SYNCED');
    await nextTick();

    const minutes = delays.map((ms) => ms / 60_000);

    // Math.random is pinned at 0.5, so jitter contributes nothing and each delay
    // is exactly the backed-off interval: 15, then doubling to the 60 cap, then
    // straight back to 15 once a sync succeeds.
    expect(minutes).toEqual([15, 30, 60, 60, 15]);
  });

  it('skips a tick while a sync is already running, and does not announce', async () => {
    syncStatus.mockReturnValue('SYNCING');

    startFallbackSyncPoll();
    await nextTick();

    expect(sync).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('resumes after the running sync finishes', async () => {
    syncStatus.mockReturnValue('SYNCING');
    startFallbackSyncPoll();
    await nextTick();
    expect(sync).not.toHaveBeenCalled();

    syncStatus.mockReturnValue('SYNCED');
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('stops when asked', async () => {
    startFallbackSyncPoll();
    await nextTick();
    expect(sync).toHaveBeenCalledTimes(1);

    stopFallbackSyncPoll();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start a second loop when started twice', async () => {
    startFallbackSyncPoll();
    startFallbackSyncPoll();
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('leaves ONE loop when logout and login straddle a tick that is still in flight', async () => {
    // The lifecycle race: the in-flight tick belongs to a session that has
    // ended, and without a generation it would see `running === true` from the
    // NEW session and schedule a second chain alongside it. Both would then poll
    // forever and only one could ever be stopped.
    //
    // Counting after a SINGLE timer would not detect this: two chains scheduled
    // at the same instant still yield one sync when only the next timer is run.
    // The window advanced below is wide enough for every live chain to fire once
    // and narrow enough that no chain fires twice, so the sync count IS the
    // number of chains.
    const inFlight = deferred<undefined>();
    sync.mockReturnValueOnce(inFlight.promise);

    startFallbackSyncPoll();
    await vi.advanceTimersToNextTimerAsync();
    expect(sync).toHaveBeenCalledTimes(1);

    stopFallbackSyncPoll();
    startFallbackSyncPoll();

    inFlight.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    sync.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 1.5);

    // One chain: one further sync. Two chains: two.
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('restarts for the next session, because the poll follows the login and not the process', async () => {
    startFallbackSyncPoll();
    await nextTick();
    expect(sync).toHaveBeenCalledTimes(1);

    stopFallbackSyncPoll();
    startFallbackSyncPoll();
    await nextTick();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('unrefs the timer, so a pending poll cannot hold the main process open on quit', () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation((() => ({ unref }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout);

    startFallbackSyncPoll();

    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('spreads the interval, so clients started together do not stay in step', () => {
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
  });
});
