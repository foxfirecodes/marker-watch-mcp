import {readWatchConfig} from '../src/config.js';

describe('readWatchConfig', () => {
  it('keeps a direct command after the server separator', () => {
    expect(readWatchConfig([
      '--cwd', '/repo', '--', 'pnpm', 'exec', '--', 'tsc', '--watch',
    ], {})).toMatchObject({
      command: 'pnpm', args: ['exec', '--', 'tsc', '--watch'], cwd: '/repo',
    });
  });

  it('handles Inspector consuming the server separator', () => {
    expect(readWatchConfig([
      '--cwd', '/repo', '--log-file', '/tmp/tsc-watch.log',
      'pnpm', 'exec', '--', 'tsc', '--watch',
    ], {})).toMatchObject({
      command: 'pnpm', args: ['exec', '--', 'tsc', '--watch'], cwd: '/repo',
      logFile: '/tmp/tsc-watch.log',
    });
  });
});
