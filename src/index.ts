import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {randomUUID} from "node:crypto";
import {z} from "zod";

import {readWatchConfig} from "./config.js";
import {MAX_BACKGROUND_TIMEOUT_MS, WatchManager, WatchManagerError, type BuildSnapshot} from "./watchManager.js";

const MAX_TIMEOUT_MS = 120_000;

type AsyncBuildWait =
  | {id: string; afterBuild: number; status: "waiting"; startedAt: string}
  | {id: string; afterBuild: number; status: "completed"; startedAt: string; result: BuildSnapshot}
  | {id: string; afterBuild: number; status: "failed"; startedAt: string; error: ReturnType<typeof errorValue>};

function jsonResult(value: unknown) {
  return {
    content: [{type: "text" as const, text: JSON.stringify(value)}],
  };
}

function errorValue(error: unknown) {
  return error instanceof WatchManagerError
    ? {error: error.message, code: error.code, ...error.details}
    : {error: error instanceof Error ? error.message : String(error)};
}

function errorResult(error: unknown) {
  const value = errorValue(error);
  return {
    content: [{type: "text" as const, text: JSON.stringify(value)}],
    isError: true,
  };
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative integer.");
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}.`);
  }
}

function getStatusWithLatestBuild(watchManager: WatchManager) {
  const latestBuild = watchManager.getLatestSnapshot();
  return {
    ...watchManager.getStatus(),
    ...(latestBuild === undefined
      ? {}
      : {
          latestBuild: {
            build: latestBuild.build,
            durationMs: latestBuild.durationMs,
            outputLength: latestBuild.output.length,
          },
        }),
  };
}

export async function startServer(): Promise<void> {
  const watchManager = new WatchManager(readWatchConfig());
  const asyncBuildWaits = new Map<string, AsyncBuildWait>();
  const server = new McpServer({name: "tsc-watch-mcp", version: "1.0.0"});
  const transport = new StdioServerTransport();
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await watchManager.shutdown();
    await server.close();
  };

  server.registerTool(
    "get_tsc_status",
    {
      description: "Return the TypeScript watch process status and latest build summary.",
    },
    async () => jsonResult(getStatusWithLatestBuild(watchManager)),
  );

  server.registerTool(
    "start_tsc_build_wait",
    {
      description: "Start a non-blocking wait for the first TypeScript build after afterBuild.",
      inputSchema: {
        afterBuild: z.number().int().min(0),
        timeoutMs: z.number().int().min(0).max(MAX_BACKGROUND_TIMEOUT_MS).default(MAX_BACKGROUND_TIMEOUT_MS),
      },
    },
    async ({afterBuild, timeoutMs}) => {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      asyncBuildWaits.set(id, {id, afterBuild, status: "waiting", startedAt});
      void watchManager.awaitBuildInBackground(afterBuild, timeoutMs).then(
        result => asyncBuildWaits.set(id, {id, afterBuild, status: "completed", startedAt, result}),
        error => asyncBuildWaits.set(id, {id, afterBuild, status: "failed", startedAt, error: errorValue(error)}),
      );
      return jsonResult({id, afterBuild, status: "waiting", startedAt});
    },
  );

  server.registerTool(
    "get_tsc_build_wait",
    {
      description: "Return the status or final result for a non-blocking TypeScript build wait.",
      inputSchema: {id: z.string().uuid()},
    },
    async ({id}) => {
      const wait = asyncBuildWaits.get(id);
      if (wait === undefined) return errorResult(new Error(`No build wait exists with id ${id}.`));
      return wait.status === "failed"
        ? {content: [{type: "text" as const, text: JSON.stringify(wait.error)}], isError: true}
        : jsonResult(wait);
    },
  );

  server.registerTool(
    "get_tsc_output",
    {
      description: "Return recent raw stdout and stderr received from the TypeScript watch process.",
      inputSchema: {tailChars: z.number().int().positive().max(1_000_000).default(50_000)},
    },
    async ({tailChars}) => {
      const output = watchManager.getOutput(tailChars);
      return jsonResult({output, outputLength: output.length, truncated: output.length === tailChars});
    },
  );

  server.registerTool(
    "await_tsc_build",
    {
      description: "Wait for the first completed TypeScript build after afterBuild.",
      inputSchema: {
        afterBuild: z.number().int().min(0),
        timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).default(30_000),
      },
    },
    async ({afterBuild, timeoutMs}) => {
      try {
        assertTimeout(timeoutMs);
        return jsonResult(await watchManager.awaitBuild(afterBuild, timeoutMs));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_tsc_build",
    {
      description: "Return a completed TypeScript build from the retained build history.",
      inputSchema: {build: z.number().int().positive().optional()},
    },
    async ({build}) => {
      try {
        const snapshot = watchManager.getBuild(build);
        if (snapshot === undefined) {
          throw new Error(
            build === undefined
              ? "No TypeScript build has completed yet."
              : `TypeScript build ${build} is not retained in the 20-build history.`,
          );
        }
        return jsonResult(snapshot);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  process.stdin.once("end", () => void stop());
  process.stdin.once("close", () => void stop());
  server.server.onclose = () => void stop();

  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
