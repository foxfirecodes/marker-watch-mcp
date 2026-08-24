import {MarkerWatchManager} from '../src/markerWatchManager.js';
import {emitVersion, END, FakeWatcher, flushWatcherEvents, START} from './fakeWatcher.js';

describe('MarkerWatchManager', () => {
  let child: FakeWatcher;
  let spawn: jest.Mock;
  let manager: MarkerWatchManager;

  beforeEach(() => {
    child = new FakeWatcher();
    spawn = jest.fn(() => child);
    manager = new MarkerWatchManager({
      command: 'watcher', args: ['--', 'lint'], cwd: '/project',
      startMarker: '@@build:start@@', endMarker: '@@build:end@@', spawn,
    });
  });

  afterEach(async () => manager.stop());

  it('starts exactly one configured process', () => {
    expect(spawn).toHaveBeenCalledWith('watcher', ['--', 'lint'], {
      cwd: '/project', shell: false, detached: process.platform !== 'win32',
    });
  });

  it('captures marker-delimited output as version 1', async () => {
    emitVersion(child);
    await flushWatcherEvents();
    expect(manager.getStatus()).toMatchObject({state: 'idle', latestCompletedVersion: 1});
    expect(manager.getVersion()).toMatchObject({version: 1, output: `${START}diagnostic\n${END}`});
  });

  it('increments versions and waits after a baseline', async () => {
    emitVersion(child);
    const waiting = manager.awaitVersion(1, 1_000);
    emitVersion(child, 'second diagnostic\n');
    await expect(waiting).resolves.toMatchObject({version: 2, output: expect.stringContaining('second')});
  });

  it('returns an already-completed later version immediately', async () => {
    emitVersion(child);
    emitVersion(child);
    await expect(manager.awaitVersion(1)).resolves.toMatchObject({version: 2});
  });

  it('handles markers split across chunks and strips ANSI only for matching', async () => {
    child.writeStdout('\u001B[36m@@build:st');
    child.writeStdout('art@@\u001B[0m\r\nbody\r');
    child.writeStdout('\n\u001B[32m@@build:end@@\u001B[0m\r\n');
    await flushWatcherEvents();
    expect(manager.getVersion()).toMatchObject({
      output: '\u001B[36m@@build:start@@\u001B[0m\r\nbody\r\n\u001B[32m@@build:end@@\u001B[0m\r\n',
    });
  });

  it('keeps raw stdout and stderr chunks in received order', async () => {
    child.writeStdout(START);
    child.writeStdout('stdout begins');
    child.writeStderr('stderr next\n');
    child.writeStdout(' and ends\n');
    child.writeStdout(END);
    await flushWatcherEvents();
    expect(manager.getVersion()?.output).toBe(`${START}stdout beginsstderr next\n and ends\n${END}`);
  });

  it('returns useful timeout state', async () => {
    await expect(manager.awaitVersion(4, 10)).rejects.toMatchObject({
      code: 'TIMEOUT', details: {afterVersion: 4, latestCompletedVersion: 0, state: 'starting'},
    });
  });

  it('allows an async wait longer than a tool request', async () => {
    const waiting = manager.awaitVersionInBackground(0, 150_000);
    emitVersion(child);
    await expect(waiting).resolves.toMatchObject({version: 1});
  });

  it('rejects waiters with all captured output after an unexpected exit', async () => {
    child.writeStdout('startup\n');
    const waiting = manager.awaitVersion(0, 1_000);
    const rejected = expect(waiting).rejects.toMatchObject({
      code: 'EXITED', details: {finalOutput: 'startup\n'},
    });
    child.exit(17);
    await rejected;
  });

  it('evicts old versions after 20 snapshots', async () => {
    for (let version = 0; version < 21; version += 1) emitVersion(child);
    expect(manager.getVersion(21)).toMatchObject({version: 21});
    expect(() => manager.getVersion(1)).toThrow(/expired/i);
  });
});
