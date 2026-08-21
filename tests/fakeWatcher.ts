import {EventEmitter} from 'node:events';

/** A controllable stand-in for the long-lived `tsc --watch` child process. */
export class FakeWatcher extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
  killed = false;

  writeStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }

  writeStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  kill = jest.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

export async function flushWatcherEvents(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

export const START = '12:00:00 PM - Starting compilation in watch mode...\n';
export const REBUILD_START =
  '12:01:00 PM - File change detected. Starting incremental compilation...\n';
export const COMPLETE =
  '12:00:01 PM - Found 0 errors. Watching for file changes.\n';

export function emitBuild(
  child: FakeWatcher,
  options: {start?: string; body?: string; complete?: string} = {},
): void {
  child.writeStdout(options.start ?? START);
  child.writeStdout(options.body ?? 'src/index.ts(1,1): error TS1005: Test error\n');
  child.writeStdout(options.complete ?? COMPLETE);
}
