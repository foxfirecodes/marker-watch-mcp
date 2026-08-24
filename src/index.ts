import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readMarkerWatchConfig } from "./config.js";
import {
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MarkerWatchError,
  MarkerWatchManager,
  type VersionSnapshot,
} from "./markerWatchManager.js";

type AsyncVersionWait =
  | { id: string; afterVersion: number; status: "pending"; startedAt: string }
  | {
      id: string;
      afterVersion: number;
      status: "completed";
      startedAt: string;
      result: VersionSnapshot;
    }
  | {
      id: string;
      afterVersion: number;
      status: "failed";
      startedAt: string;
      error: ReturnType<typeof errorValue>;
    };

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorValue(error: unknown) {
  return error instanceof MarkerWatchError
    ? { error: error.message, code: error.code, ...error.details }
    : { error: error instanceof Error ? error.message : String(error) };
}

function errorResult(error: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(errorValue(error)) },
    ],
    isError: true,
  };
}

export async function startServer(): Promise<void> {
  const manager = new MarkerWatchManager(readMarkerWatchConfig());
  const asyncWaits = new Map<string, AsyncVersionWait>();
  const server = new McpServer({ name: "marker-watch-mcp", version: "1.0.0" });
  const transport = new StdioServerTransport();
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await manager.stop();
    await server.close();
  };

  server.registerTool(
    "get_build_status",
    {
      description:
        "Return the build process state and latest completed version.",
    },
    async () => {
      const latestVersion = manager.getLatestSnapshot();
      return jsonResult({
        ...manager.getStatus(),
        ...(latestVersion === undefined
          ? {}
          : {
              latestVersion: {
                version: latestVersion.version,
                durationMs: latestVersion.durationMs,
                outputLength: latestVersion.output.length,
              },
            }),
      });
    },
  );

  server.registerTool(
    "get_build",
    {
      description: "Return the build result of the specified version.",
      inputSchema: {
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Defaults to the latest completed version."),
      },
    },
    async ({ version }) => {
      try {
        const snapshot = manager.getVersion(version);
        if (snapshot === undefined)
          throw new Error("No completed build version is available yet.");
        return jsonResult(snapshot);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "await_build",
    {
      description:
        "Await the build result of the first completed version after afterVersion.",
      inputSchema: {
        afterVersion: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Defaults to the latest completed version."),
        timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).default(30_000),
      },
    },
    async ({ afterVersion, timeoutMs }) => {
      try {
        const baseline =
          afterVersion ?? manager.getStatus().latestCompletedVersion;
        return jsonResult(await manager.awaitVersion(baseline, timeoutMs));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "start_build_wait",
    {
      description:
        "Start a non-blocking wait for the first completed version after afterVersion.",
      inputSchema: {
        afterVersion: z.number().int().min(0),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_BACKGROUND_TIMEOUT_MS)
          .default(MAX_BACKGROUND_TIMEOUT_MS),
      },
    },
    async ({ afterVersion, timeoutMs }) => {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      asyncWaits.set(id, { id, afterVersion, status: "pending", startedAt });
      void manager.awaitVersionInBackground(afterVersion, timeoutMs).then(
        (result) =>
          asyncWaits.set(id, {
            id,
            afterVersion,
            status: "completed",
            startedAt,
            result,
          }),
        (error) =>
          asyncWaits.set(id, {
            id,
            afterVersion,
            status: "failed",
            startedAt,
            error: errorValue(error),
          }),
      );
      return jsonResult({ id, afterVersion, status: "pending", startedAt });
    },
  );

  server.registerTool(
    "get_build_wait",
    {
      description:
        "Return the state or final result of a non-blocking build wait.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const wait = asyncWaits.get(id);
      if (wait === undefined)
        return errorResult(new Error(`No build wait exists with id ${id}.`));
      if (wait.status === "failed") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(wait.error) },
          ],
          isError: true,
        };
      }
      return jsonResult(wait);
    },
  );

  server.registerTool(
    "get_live_output",
    {
      description: "Return recent raw stdout and stderr from build processes.",
      inputSchema: {
        tailChars: z.number().int().positive().max(1_000_000).default(50_000),
      },
    },
    async ({ tailChars }) => {
      const output = manager.getOutput(tailChars);
      return jsonResult({
        output,
        outputLength: output.length,
        truncated: output.length === tailChars,
      });
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
  void startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
