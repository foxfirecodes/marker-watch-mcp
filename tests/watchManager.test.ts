import {WatchManager} from '../src/watchManager.js';
import {
  COMPLETE,
  emitBuild,
  FakeWatcher,
  flushWatcherEvents,
  REBUILD_START,
  START,
} from './fakeWatcher.js';

describe('WatchManager', () => {
  let child: FakeWatcher;
  let spawn: jest.Mock;
  let manager: WatchManager;

  beforeEach(() => {
    child = new FakeWatcher();
    spawn = jest.fn(() => child);
    manager = new WatchManager({
      command: 'pnpm',
      args: ['exec', 'tsc', '--watch', '--pretty', 'false', '--preserveWatchOutput'],
      cwd: '/project',
      spawn,
    });
  });

  afterEach(async () => {
    await manager.stop();
  });

  it('starts exactly one configured child process', () => {
    manager.start();
    manager.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'tsc', '--watch', '--pretty', 'false', '--preserveWatchOutput'],
      {cwd: '/project', shell: false, detached: process.platform !== 'win32'},
    );
  });

  it('records the initial compilation as build 1', async () => {
    manager.start();
    emitBuild(child);
    await flushWatcherEvents();

    expect(manager.getStatus()).toMatchObject({
      state: 'watching',
      pid: 4242,
      latestCompletedBuild: 1,
    });
    expect(manager.getBuild()).toMatchObject({build: 1, output: expect.stringContaining(COMPLETE)});
  });

  it('records a rebuild as build 2', async () => {
    manager.start();
    emitBuild(child);
    emitBuild(child, {start: REBUILD_START});
    await flushWatcherEvents();

    expect(manager.getBuild()).toMatchObject({build: 2});
    expect(manager.getStatus()).toMatchObject({latestCompletedBuild: 2, state: 'watching'});
  });

  it('waits for the first build strictly after the requested baseline', async () => {
    manager.start();
    emitBuild(child);
    const waiting = manager.awaitBuild(1, 1_000);

    emitBuild(child, {start: REBUILD_START, body: 'rebuild diagnostic\n'});
    await flushWatcherEvents();

    await expect(waiting).resolves.toMatchObject({
      build: 2,
      output: expect.stringContaining('rebuild diagnostic'),
    });
  });

  it('allows an asynchronous wait to outlast the synchronous tool limit', async () => {
    manager.start();
    const waiting = manager.awaitBuildInBackground(0, 150_000);
    emitBuild(child);
    await flushWatcherEvents();

    await expect(waiting).resolves.toMatchObject({build: 1});
  });

  it('resolves concurrent waiters independently', async () => {
    manager.start();
    emitBuild(child);
    await flushWatcherEvents();
    const afterZero = manager.awaitBuild(0, 1_000);
    const afterOne = manager.awaitBuild(1, 1_000);

    await expect(afterZero).resolves.toMatchObject({build: 1});
    emitBuild(child, {start: REBUILD_START});
    await flushWatcherEvents();
    await expect(afterOne).resolves.toMatchObject({build: 2});
  });

  it('returns an already-completed next build immediately', async () => {
    manager.start();
    emitBuild(child);
    emitBuild(child, {start: REBUILD_START});
    await flushWatcherEvents();

    await expect(manager.awaitBuild(1, 1_000)).resolves.toMatchObject({build: 2});
  });

  it('detects markers split across data chunks', async () => {
    manager.start();
    child.writeStdout('12:00:00 PM - Starting comp');
    child.writeStdout('ilation in watch mode...\r\nbody\r');
    child.writeStdout('\n12:00:01 PM - Found 0 errors. Watching for ');
    child.writeStdout('file changes.\r\n');
    await flushWatcherEvents();

    expect(manager.getBuild()).toMatchObject({
      build: 1,
      output:
        '12:00:00 PM - Starting compilation in watch mode...\r\nbody\r\n12:00:01 PM - Found 0 errors. Watching for file changes.\r\n',
    });
  });

  it('matches ANSI-decorated markers but returns raw output', async () => {
    manager.start();
    child.writeStdout(`\u001B[36m${START.trim()}\u001B[0m\n`);
    child.writeStderr('\u001B[31merror from stderr\u001B[0m\n');
    child.writeStdout(`\u001B[32m${COMPLETE.trim()}\u001B[0m\n`);
    await flushWatcherEvents();

    expect(manager.getBuild()).toMatchObject({
      build: 1,
      output: expect.stringContaining('\u001B[36m'),
    });
  });

  it('keeps raw chunk order when stdout is partial and stderr arrives between chunks', async () => {
    manager.start();
    emitBuild(child);
    child.writeStdout(REBUILD_START);
    child.writeStdout('stdout begins');
    child.writeStderr('stderr arrives next\n');
    child.writeStdout(' and stdout ends\n');
    child.writeStdout(COMPLETE);
    await flushWatcherEvents();

    expect(manager.getBuild(2)?.output).toContain(
      `${REBUILD_START}stdout beginsstderr arrives next\n and stdout ends\n${COMPLETE}`,
    );
  });

  it('rejects a timed-out wait with its baseline, current build, and state', async () => {
    manager.start();

    await expect(manager.awaitBuild(4, 10)).rejects.toMatchObject({
      code: 'TIMEOUT',
      details: {afterBuild: 4, latestCompletedBuild: 0, state: 'starting'},
    });
  });

  it('rejects pending waiters when the child exits unexpectedly', async () => {
    manager.start();
    const waiting = manager.awaitBuild(0, 1_000);
    const rejected = expect(waiting).rejects.toThrow(/17/);
    child.exit(17);
    await flushWatcherEvents();

    await rejected;
    expect(manager.getStatus()).toMatchObject({state: 'exited', exitCode: 17});
  });

  it('includes startup output and an unterminated final line in exit details', async () => {
    manager.start();
    const startup = 'watcher booting\n';
    const partial = 'final diagnostic without newline';
    child.writeStdout(startup);
    child.writeStdout(START);
    child.writeStderr(partial);
    const waiting = manager.awaitBuild(0, 1_000);
    const rejected = expect(waiting).rejects.toMatchObject({
      code: 'EXITED',
      details: {finalOutput: `${startup}${START}${partial}`},
    });
    child.exit(12);
    await flushWatcherEvents();

    await rejected;
  });

  it('terminates its child on server shutdown', async () => {
    manager.start();
    await manager.stop();

    expect(child.kill).toHaveBeenCalled();
  });

  it('keeps only the most recent 20 build snapshots', async () => {
    manager.start();
    emitBuild(child);
    for (let build = 2; build <= 21; build++) {
      emitBuild(child, {start: REBUILD_START, body: `build ${build}\n`});
    }
    await flushWatcherEvents();

    expect(manager.getBuild(21)).toMatchObject({build: 21});
    expect(() => manager.getBuild(1)).toThrow(/expired|not found/i);
  });
});
