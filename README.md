# marker-watch-mcp

`marker-watch-mcp` runs one long-lived command and turns its output into
versioned snapshots. A start marker opens a version; an end marker closes it.
The server keeps the last 20 completed versions and exposes them over stdio
MCP.

It does not watch files, restart commands, or parse diagnostics. Use any
external watcher that emits markers and forwards its child command's output.

## Install

```sh
pnpm install
pnpm build
pnpm test
```

## Command contract

The configured command must remain running and write both markers to stdout or
stderr. It must not overlap runs: one start marker, all output for that run,
then one end marker.

Markers are literal substrings matched against complete output lines after ANSI
control sequences are removed. Returned snapshots retain the original text.

## Configuration

Pass server options before `--`; everything after it becomes the command and
its exact arguments.

```sh
node dist/index.js \
  --cwd /absolute/path/to/repo \
  --start-marker '@@build:start@@' \
  --end-marker '@@build:end@@' \
  -- watcher --watch-paths 'src/**/*.ts' -- clyde lint tsc --no-watch app
```

MCP client example:

```json
{
  "mcpServers": {
    "marker-watch": {
      "command": "node",
      "args": [
        "/absolute/path/to/marker-watch-mcp/dist/index.js",
        "--cwd", "/absolute/path/to/repo",
        "--start-marker", "@@build:start@@",
        "--end-marker", "@@build:end@@",
        "--",
        "watcher", "--watch-paths", "src/**/*.ts", "--",
        "clyde", "lint", "tsc", "--no-watch", "app"
      ]
    }
  }
}
```

Environment alternatives are `MARKER_WATCH_MCP_COMMAND`,
`MARKER_WATCH_MCP_ARGS` (a JSON string array), `MARKER_WATCH_MCP_CWD`,
`MARKER_WATCH_MCP_START_MARKER`, and `MARKER_WATCH_MCP_END_MARKER`.

Pass `--log-file /tmp/marker-watch.log` or set
`MARKER_WATCH_MCP_LOG_FILE` to write raw received output to a file. The file is
truncated when the server starts.

## MCP tools

- `get_build_status` returns process state, active version, and latest version.
- `get_build({ version? })` returns a cached snapshot; omit `version` for the latest.
- `await_build({ afterVersion?, timeoutMs? })` waits up to two minutes. When
  `afterVersion` is omitted, it uses the current completed version and waits
  for the next one.
- `start_build_wait({ afterVersion, timeoutMs? })` returns a wait ID immediately;
  `get_build_wait({ id })` returns its `pending` state or result. Background waits last up
  to one hour.
- `get_live_output({ tailChars? })` returns recent raw stdout and stderr,
  including an active version that has not reached its end marker yet.

## Client flow

```text
get_build_status()                    -> latestCompletedVersion: 41
change files (the external watcher starts a run)
await_build({ afterVersion: 41 })     -> version 42 and full output
```

For long runs, replace the final call with `start_build_wait`, then query its
ID later. On `SIGINT`, `SIGTERM`, or MCP transport shutdown, the server stops
the command and its Unix process group.

## Manual Inspector check

```sh
pnpm build
pnpm dlx @modelcontextprotocol/inspector \
  node /absolute/path/to/marker-watch-mcp/dist/index.js \
  --cwd /absolute/path/to/repo \
  --start-marker '@@build:start@@' \
  --end-marker '@@build:end@@' \
  -- watcher --watch-paths 'src/**/*.ts' -- clyde lint tsc --no-watch app
```
