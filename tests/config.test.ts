import {readMarkerWatchConfig} from '../src/config.js';

describe('readMarkerWatchConfig', () => {
  const markers = ['--start-marker', '@@start@@', '--end-marker', '@@end@@'];

  it('reads a direct command without changing its arguments', () => {
    expect(readMarkerWatchConfig(['--cwd', '/repo', ...markers, '--', 'pnpm', 'exec', '--', 'lint'], {})).toMatchObject({
      command: 'pnpm', args: ['exec', '--', 'lint'], cwd: '/repo', startMarker: '@@start@@', endMarker: '@@end@@',
    });
  });

  it('handles Inspector consuming the outer separator', () => {
    expect(readMarkerWatchConfig(['--cwd', '/repo', ...markers, 'pnpm', 'exec', '--', 'lint'], {})).toMatchObject({
      command: 'pnpm', args: ['exec', '--', 'lint'],
    });
  });

  it('requires both markers', () => {
    expect(() => readMarkerWatchConfig(['--command', 'watcher'], {})).toThrow(/start marker/i);
  });
});
