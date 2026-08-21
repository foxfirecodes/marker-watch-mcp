import {spawn as nodeSpawn, type ChildProcess} from "node:child_process";
import {appendFileSync, writeFileSync} from "node:fs";

export const MAX_SNAPSHOTS = 20;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_BACKGROUND_TIMEOUT_MS = 3_600_000;

export type BuildSnapshot = Readonly<{
  build: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output: string;
}>;

export type WatchStatus = {
  state: "starting" | "watching" | "compiling" | "exited";
  pid?: number;
  latestCompletedBuild: number;
  activeBuild?: number;
  startedAt: string;
  lastCompletedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

export type WatchCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
  logFile?: string;
};

export type ChildProcessLike = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "kill" | "once">;
export type Spawn = (
  command: string,
  args: readonly string[],
  options: {cwd: string; shell: false; detached: boolean},
) => ChildProcessLike;

export type WatchManagerOptions = WatchCommand & {
  spawn?: Spawn;
  now?: () => Date;
};

export class WatchManagerError extends Error {
  public constructor(
    message: string,
    public readonly code: "TIMEOUT" | "EXITED" | "INVALID_ARGUMENT" | "SHUTDOWN",
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WatchManagerError";
  }
}

const START_RE = /Starting compilation in watch mode|File change detected\. Starting incremental compilation/i;
const COMPLETE_RE = /Found \d+ errors?\.\s*Watching for file changes\./i;
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

type Waiter = {
  afterBuild: number;
  resolve: (snapshot: BuildSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Captures one long-lived `tsc --watch` process. */
export class WatchManager {
  private readonly child: ChildProcessLike;
  private readonly now: () => Date;
  private readonly logFile?: string;
  private readonly pendingOperations: Array<() => void> = [];
  private handlingEvents = false;
  private readonly streamBuffers = new Map<string, string>();
  private receivedOutput = "";
  private readonly snapshots: BuildSnapshot[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly processStartedAt: string;
  private isCompiling = false;
  private cycleStartedAt?: Date;
  private currentCycleOutput = "";
  private completedBuild = 0;
  private lastCompletedAt?: string;
  private exitCode?: number | null;
  private signal?: string | null;
  private exitErrorMessage?: string;
  private hasExited = false;

  public constructor(options: WatchManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.logFile = options.logFile;
    if (this.logFile !== undefined) writeFileSync(this.logFile, "");
    this.processStartedAt = this.now().toISOString();
    const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      // A detached Unix child becomes its own process-group leader, making
      // kill(-pid) terminate package-manager descendants too.
      detached: process.platform !== "win32",
    });
    this.attachStream(this.child.stdout, "stdout");
    this.attachStream(this.child.stderr, "stderr");
    this.child.once("error", error => this.enqueue(() => this.handleExit(null, null, error)));
    this.child.once("close", (code, signal) => this.enqueue(() => this.handleExit(code, signal)));
  }

  public getStatus(): WatchStatus {
    const status: WatchStatus = {
      state: this.hasExited ? "exited" : this.isCompiling ? "compiling" : this.completedBuild > 0 ? "watching" : "starting",
      latestCompletedBuild: this.completedBuild,
      startedAt: this.processStartedAt,
    };
    if (this.child.pid !== undefined) status.pid = this.child.pid;
    if (this.isCompiling) status.activeBuild = this.completedBuild + 1;
    if (this.lastCompletedAt !== undefined) status.lastCompletedAt = this.lastCompletedAt;
    if (this.hasExited) {
      status.exitCode = this.exitCode;
      status.signal = this.signal;
      if (this.exitErrorMessage !== undefined) status.error = this.exitErrorMessage;
    }
    return status;
  }

  public getLatestSnapshot(): BuildSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  /** Return the most recently received combined stdout and stderr text. */
  public getOutput(tailChars?: number): string {
    return tailChars === undefined ? this.receivedOutput : this.receivedOutput.slice(-tailChars);
  }

  public getBuild(build?: number): BuildSnapshot | undefined {
    if (build === undefined) return this.getLatestSnapshot();
    const snapshot = this.snapshots.find(candidate => candidate.build === build);
    if (snapshot) return snapshot;
    throw new WatchManagerError(`Build ${build} was not found or has expired from the 20-build buffer`, "INVALID_ARGUMENT", {
      build,
      oldestAvailableBuild: this.snapshots[0]?.build,
      latestCompletedBuild: this.completedBuild,
    });
  }

  /** The process starts in the constructor; this keeps setup code idempotent. */
  public start(): void {}

  public awaitBuild(afterBuild: number, timeoutMs = 30_000): Promise<BuildSnapshot> {
    return this.waitForBuild(afterBuild, timeoutMs, MAX_TIMEOUT_MS);
  }

  /** Wait longer without holding an MCP tool request open. */
  public awaitBuildInBackground(afterBuild: number, timeoutMs = MAX_BACKGROUND_TIMEOUT_MS): Promise<BuildSnapshot> {
    return this.waitForBuild(afterBuild, timeoutMs, MAX_BACKGROUND_TIMEOUT_MS);
  }

  private waitForBuild(afterBuild: number, timeoutMs: number, maximumTimeoutMs: number): Promise<BuildSnapshot> {
    if (!Number.isInteger(afterBuild) || afterBuild < 0) {
      return Promise.reject(new WatchManagerError("afterBuild must be a non-negative integer", "INVALID_ARGUMENT", {afterBuild}));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimeoutMs) {
      return Promise.reject(new WatchManagerError(`timeoutMs must be between 0 and ${maximumTimeoutMs}`, "INVALID_ARGUMENT", {timeoutMs}));
    }
    const available = this.snapshots.find(snapshot => snapshot.build > afterBuild);
    if (available) return Promise.resolve(available);
    if (this.hasExited) return Promise.reject(this.exitError());

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        afterBuild,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new WatchManagerError(`Timed out waiting for a completed TypeScript build (afterBuild=${afterBuild}, latestCompletedBuild=${this.completedBuild}, state=${this.getStatus().state})`, "TIMEOUT", {
            afterBuild,
            latestCompletedBuild: this.completedBuild,
            state: this.getStatus().state,
          }));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      // A stream event may have completed a build between the first lookup and registration.
      void this.enqueue(() => this.resolveWaiterIfReady(waiter));
    });
  }

  /** Ask the child (and, on Unix, its process group) to stop. */
  public async shutdown(): Promise<void> {
    if (this.hasExited) return;
    const pid = this.child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // The child may not lead a group (notably in tests), so use its direct handle.
      }
    }
    this.child.kill("SIGTERM");
  }

  public stop(): Promise<void> {
    return this.shutdown();
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
    const capturingChunk = this.isCompiling;
    if (capturingChunk) this.currentCycleOutput += text;
    let buffered = (this.streamBuffers.get(key) ?? "") + text;
    // Keep a trailing CR until we know whether the next chunk begins with LF.
    const completeEnd = buffered.endsWith("\r") ? buffered.length - 1 : buffered.length;
    const complete = buffered.slice(0, completeEnd);
    buffered = buffered.slice(completeEnd);
    const lines = complete.split(/(\r\n|\n|\r)/);
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const rawLine = lines[index];
      const delimiter = lines[index + 1];
      if (rawLine !== undefined && delimiter !== undefined) {
        this.acceptLine(rawLine + delimiter, !capturingChunk);
      }
    }
    if (lines.length % 2 === 1) buffered = (lines[lines.length - 1] ?? "") + buffered;
    // A start marker can share a chunk with an unfinished following line. It
    // has already arrived and therefore belongs in this build's raw output.
    if (!capturingChunk && this.isCompiling && buffered !== "") {
      this.currentCycleOutput += buffered;
    }
    this.streamBuffers.set(key, buffered);
  }

  private acceptLine(line: string, appendRawLine: boolean): void {
    const normalized = line.replace(ANSI_RE, "");
    if (START_RE.test(normalized)) {
      this.isCompiling = true;
      this.cycleStartedAt = this.now();
      this.currentCycleOutput = line;
      appendRawLine = false;
    }
    if (this.isCompiling && appendRawLine) this.currentCycleOutput += line;
    if (this.isCompiling && COMPLETE_RE.test(normalized)) this.completeBuild();
  }

  private completeBuild(): void {
    const completedAt = this.now();
    const startedAt = this.cycleStartedAt ?? completedAt;
    const snapshot: BuildSnapshot = Object.freeze({
      build: ++this.completedBuild,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      output: this.currentCycleOutput,
    });
    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.lastCompletedAt = snapshot.completedAt;
    this.isCompiling = false;
    this.cycleStartedAt = undefined;
    this.currentCycleOutput = "";
    for (const waiter of [...this.waiters]) this.resolveWaiterIfReady(waiter);
  }

  private resolveWaiterIfReady(waiter: Waiter): void {
    const snapshot = this.snapshots.find(candidate => candidate.build > waiter.afterBuild);
    if (!snapshot) return;
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
      appendFileSync(this.logFile, `[tsc-watch-mcp] Failed to start watcher: ${error.message}\n`);
    }
    const exitError = this.exitError(error);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      // Stream `close` can fire synchronously in test doubles. Deferring avoids
      // an unhandled-rejection turn before the caller receives its promise.
      queueMicrotask(() => waiter.reject(exitError));
    }
    this.waiters.clear();
  }

  private exitError(cause?: Error): WatchManagerError {
    const suffix = cause ? `: ${cause.message}` : "";
    return new WatchManagerError(`The TypeScript watch process exited (exitCode=${this.exitCode ?? "null"}, signal=${this.signal ?? "null"})${suffix}`, "EXITED", {
      exitCode: this.exitCode ?? null,
      signal: this.signal ?? null,
      finalOutput: this.receivedOutput,
    });
  }
}
