import {spawn as nodeSpawn, type ChildProcess} from "node:child_process";
import {appendFileSync, writeFileSync} from "node:fs";

export const MAX_SNAPSHOTS = 20;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_BACKGROUND_TIMEOUT_MS = 3_600_000;

export type VersionSnapshot = Readonly<{
  version: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output: string;
}>;

export type MarkerWatchStatus = {
  state: "starting" | "idle" | "running" | "exited";
  pid?: number;
  latestCompletedVersion: number;
  activeVersion?: number;
  startedAt: string;
  lastCompletedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

export type MarkerWatchCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
  startMarker: string;
  endMarker: string;
  logFile?: string;
};

export type ChildProcessLike = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "kill" | "once">;
export type Spawn = (
  command: string,
  args: readonly string[],
  options: {cwd: string; shell: false; detached: boolean},
) => ChildProcessLike;

export type MarkerWatchManagerOptions = MarkerWatchCommand & {spawn?: Spawn; now?: () => Date};

export class MarkerWatchError extends Error {
  public constructor(
    message: string,
    public readonly code: "TIMEOUT" | "EXITED" | "INVALID_ARGUMENT",
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MarkerWatchError";
  }
}

type Waiter = {
  afterVersion: number;
  resolve: (snapshot: VersionSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Captures versions from one marker-delimited long-running command. */
export class MarkerWatchManager {
  private readonly child: ChildProcessLike;
  private readonly now: () => Date;
  private readonly logFile?: string;
  private readonly startMarker: string;
  private readonly endMarker: string;
  private readonly pendingOperations: Array<() => void> = [];
  private readonly streamBuffers = new Map<string, string>();
  private readonly snapshots: VersionSnapshot[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly processStartedAt: string;
  private receivedOutput = "";
  private currentVersionOutput = "";
  private versionStartedAt?: Date;
  private lastCompletedAt?: string;
  private completedVersion = 0;
  private handlingEvents = false;
  private isRunning = false;
  private hasExited = false;
  private exitCode?: number | null;
  private signal?: string | null;
  private exitErrorMessage?: string;

  public constructor(options: MarkerWatchManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.logFile = options.logFile;
    this.startMarker = options.startMarker;
    this.endMarker = options.endMarker;
    if (this.logFile !== undefined) writeFileSync(this.logFile, "");
    this.processStartedAt = this.now().toISOString();
    const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== "win32",
    });
    this.attachStream(this.child.stdout, "stdout");
    this.attachStream(this.child.stderr, "stderr");
    this.child.once("error", error => this.enqueue(() => this.handleExit(null, null, error)));
    this.child.once("close", (code, signal) => this.enqueue(() => this.handleExit(code, signal)));
  }

  public getStatus(): MarkerWatchStatus {
    const status: MarkerWatchStatus = {
      state: this.hasExited ? "exited" : this.isRunning ? "running" : this.completedVersion > 0 ? "idle" : "starting",
      latestCompletedVersion: this.completedVersion,
      startedAt: this.processStartedAt,
    };
    if (this.child.pid !== undefined) status.pid = this.child.pid;
    if (this.isRunning) status.activeVersion = this.completedVersion + 1;
    if (this.lastCompletedAt !== undefined) status.lastCompletedAt = this.lastCompletedAt;
    if (this.hasExited) {
      status.exitCode = this.exitCode;
      status.signal = this.signal;
      if (this.exitErrorMessage !== undefined) status.error = this.exitErrorMessage;
    }
    return status;
  }

  public getLatestSnapshot(): VersionSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  public getOutput(tailChars?: number): string {
    return tailChars === undefined ? this.receivedOutput : this.receivedOutput.slice(-tailChars);
  }

  public getVersion(version?: number): VersionSnapshot | undefined {
    if (version === undefined) return this.getLatestSnapshot();
    const snapshot = this.snapshots.find(candidate => candidate.version === version);
    if (snapshot !== undefined) return snapshot;
    throw new MarkerWatchError(`Version ${version} was not found or has expired from the ${MAX_SNAPSHOTS}-version buffer`, "INVALID_ARGUMENT", {
      version,
      oldestAvailableVersion: this.snapshots[0]?.version,
      latestCompletedVersion: this.completedVersion,
    });
  }

  public awaitVersion(afterVersion: number, timeoutMs = 30_000): Promise<VersionSnapshot> {
    return this.waitForVersion(afterVersion, timeoutMs, MAX_TIMEOUT_MS);
  }

  public awaitVersionInBackground(afterVersion: number, timeoutMs = MAX_BACKGROUND_TIMEOUT_MS): Promise<VersionSnapshot> {
    return this.waitForVersion(afterVersion, timeoutMs, MAX_BACKGROUND_TIMEOUT_MS);
  }

  public async stop(): Promise<void> {
    if (this.hasExited) return;
    const pid = this.child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // Test doubles and nonstandard launchers may not create a group.
      }
    }
    this.child.kill("SIGTERM");
  }

  private waitForVersion(afterVersion: number, timeoutMs: number, maximumTimeoutMs: number): Promise<VersionSnapshot> {
    if (!Number.isInteger(afterVersion) || afterVersion < 0) {
      return Promise.reject(new MarkerWatchError("afterVersion must be a non-negative integer", "INVALID_ARGUMENT", {afterVersion}));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimeoutMs) {
      return Promise.reject(new MarkerWatchError(`timeoutMs must be between 0 and ${maximumTimeoutMs}`, "INVALID_ARGUMENT", {timeoutMs}));
    }
    const available = this.snapshots.find(snapshot => snapshot.version > afterVersion);
    if (available !== undefined) return Promise.resolve(available);
    if (this.hasExited) return Promise.reject(this.exitError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        afterVersion,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new MarkerWatchError("Timed out waiting for a completed version", "TIMEOUT", {
            afterVersion,
            latestCompletedVersion: this.completedVersion,
            state: this.getStatus().state,
          }));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.enqueue(() => this.resolveWaiterIfReady(waiter));
    });
  }

  private attachStream(stream: ChildProcess["stdout"], key: string): void {
    if (!stream) return;
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.enqueue(() => this.acceptChunk(key, text));
    });
  }

  private enqueue(operation: () => void): void {
    this.pendingOperations.push(operation);
    if (this.handlingEvents) return;
    this.handlingEvents = true;
    try {
      while (this.pendingOperations.length > 0) this.pendingOperations.shift()!();
    } finally {
      this.handlingEvents = false;
    }
  }

  private acceptChunk(key: string, text: string): void {
    this.receivedOutput += text;
    if (this.logFile !== undefined) appendFileSync(this.logFile, text);
    const capturedBeforeChunk = this.isRunning;
    if (capturedBeforeChunk) this.currentVersionOutput += text;
    let buffered = (this.streamBuffers.get(key) ?? "") + text;
    const completeEnd = buffered.endsWith("\r") ? buffered.length - 1 : buffered.length;
    const complete = buffered.slice(0, completeEnd);
    buffered = buffered.slice(completeEnd);
    const lines = complete.split(/(\r\n|\n|\r)/);
    for (let index = 0; index + 1 < lines.length; index += 2) {
      this.acceptLine(lines[index]! + lines[index + 1]!, !capturedBeforeChunk);
    }
    if (lines.length % 2 === 1) buffered = lines[lines.length - 1]! + buffered;
    if (!capturedBeforeChunk && this.isRunning && buffered !== "") this.currentVersionOutput += buffered;
    this.streamBuffers.set(key, buffered);
  }

  private acceptLine(line: string, appendRawLine: boolean): void {
    const normalized = line.replace(ANSI_RE, "");
    if (normalized.includes(this.startMarker)) {
      this.isRunning = true;
      this.versionStartedAt = this.now();
      this.currentVersionOutput = line;
      appendRawLine = false;
    }
    if (this.isRunning && appendRawLine) this.currentVersionOutput += line;
    if (this.isRunning && normalized.includes(this.endMarker)) this.completeVersion();
  }

  private completeVersion(): void {
    const completedAt = this.now();
    const startedAt = this.versionStartedAt ?? completedAt;
    const snapshot: VersionSnapshot = Object.freeze({
      version: ++this.completedVersion,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      output: this.currentVersionOutput,
    });
    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.lastCompletedAt = snapshot.completedAt;
    this.isRunning = false;
    this.versionStartedAt = undefined;
    this.currentVersionOutput = "";
    for (const waiter of [...this.waiters]) this.resolveWaiterIfReady(waiter);
  }

  private resolveWaiterIfReady(waiter: Waiter): void {
    const snapshot = this.snapshots.find(candidate => candidate.version > waiter.afterVersion);
    if (snapshot === undefined) return;
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(snapshot);
  }

  private handleExit(code: number | null, signal: string | null, error?: Error): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitCode = code;
    this.signal = signal;
    this.exitErrorMessage = error?.message;
    if (error !== undefined && this.logFile !== undefined) {
      appendFileSync(this.logFile, `[marker-watch-mcp] Failed to start command: ${error.message}\n`);
    }
    const exitError = this.exitError(error);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      queueMicrotask(() => waiter.reject(exitError));
    }
    this.waiters.clear();
  }

  private exitError(cause?: Error): MarkerWatchError {
    const suffix = cause ? `: ${cause.message}` : "";
    return new MarkerWatchError(`The marker-watch command exited (exitCode=${this.exitCode ?? "null"}, signal=${this.signal ?? "null"})${suffix}`, "EXITED", {
      exitCode: this.exitCode ?? null,
      signal: this.signal ?? null,
      finalOutput: this.receivedOutput,
    });
  }
}
