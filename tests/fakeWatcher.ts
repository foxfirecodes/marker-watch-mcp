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

export const START = '@@build:start@@\n';
export const END = '@@build:end@@\n';

export function emitVersion(
  child: FakeWatcher,
  body = 'diagnostic\n',
): void {
  child.writeStdout(START);
  child.writeStdout(body);
  child.writeStdout(END);
}
