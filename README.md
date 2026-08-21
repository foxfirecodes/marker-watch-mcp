# tsc-watch-mcp

`tsc-watch-mcp` is a local stdio MCP server that runs one TypeScript watch
command and returns the full output for each completed compilation.

It does not parse diagnostics, watch files itself, or restart TypeScript. It
keeps the configured watch process alive until the MCP server stops.

## Install and build

```sh
pnpm install
pnpm build
pnpm test
```

The server needs Node.js and a watch command that stays running.

## Configure an MCP client

Pass the watch command after `--`. Everything after `--` is sent unchanged to
`spawn(command, args, { cwd, shell: false })`.

Use `--watch`, `--pretty false`, and `--preserveWatchOutput`. Plain output is
important: terminal control codes can make watch-cycle detection unreliable.

### `npx tsc`

```json
{
  "mcpServers": {
    "tsc-watch": {
      "command": "node",
      "args": [
        "/absolute/path/to/tsc-watch-mcp/dist/index.js",
        "--cwd",
        "/absolute/path/to/repo",
        "--",
        "npx",
        "tsc",
        "--watch",
        "--pretty",
        "false",
        "--preserveWatchOutput"
      ]
    }
  }
}
```

### `pnpm exec tsc`

```json
{
  "mcpServers": {
    "tsc-watch": {
      "command": "node",
      "args": [
        "/absolute/path/to/tsc-watch-mcp/dist/index.js",
        "--cwd",
        "/absolute/path/to/repo",
        "--",
        "pnpm",
        "exec",
        "tsc",
        "--watch",
        "--pretty",
        "false",
        "--preserveWatchOutput"
      ]
    }
  }
}
```

### Build-mode projects

For project references, use TypeScript build mode:

```json
{
  "mcpServers": {
    "tsc-watch": {
      "command": "node",
      "args": [
        "/absolute/path/to/tsc-watch-mcp/dist/index.js",
        "--cwd",
        "/absolute/path/to/repo",
        "--",
        "pnpm",
        "exec",
        "tsc",
        "-b",
        "tsconfig.json",
        "--watch",
        "--pretty",
        "false",
        "--preserveWatchOutput"
      ]
    }
  }
}
```

You can instead supply `TSC_WATCH_MCP_COMMAND`, `TSC_WATCH_MCP_ARGS` (a JSON
array), and `TSC_WATCH_MCP_CWD`. Command-line settings take precedence over environment
settings.

## Debug watch output

Use `get_tsc_output` in the Inspector to see the latest raw combined stdout
and stderr. It is useful when status stays at `compiling` because it shows the
exact line that did not match the completion marker.

If the watcher fails to start, `get_tsc_status` includes its `error` field.

For a file you can inspect outside the Inspector, pass `--log-file` or set
`TSC_WATCH_MCP_LOG_FILE`. The server truncates this file when it starts, then
appends raw received output in order:

```sh
node dist/index.js --cwd /absolute/path/to/repo --log-file /tmp/tsc-watch.log -- pnpm exec tsc --watch --pretty false --preserveWatchOutput
tail -f /tmp/tsc-watch.log
```

## Tools

`get_tsc_status` reports whether the watcher is starting, compiling, waiting
for changes, or has exited. It also reports the latest completed build.

`await_tsc_build` waits for the first completed build strictly after
`afterBuild`. Pass a timeout in milliseconds (up to 120 seconds). More than
one caller can wait at once.

For slow projects, call `start_tsc_build_wait` instead. It returns an ID
immediately and waits for up to one hour in the server. Call
`get_tsc_build_wait` with that ID later; it returns `waiting`, the completed
snapshot, or an error. This works in clients such as MCP Inspector that do not
support task-notification UI.

`get_tsc_build` returns one retained build by number, or the latest build when
called without `build`. The server retains the latest 20 completed builds.

## Client flow

Take a baseline before editing. This avoids missing a fast rebuild.

```text
get_tsc_status()                         -> latestCompletedBuild: 41
edit files
await_tsc_build({ afterBuild: 41 })      -> full output for build 42
```

Build 1 is TypeScript's initial watch compilation. The server returns raw
received output, including diagnostics. It only removes ANSI control sequences
from a separate copy used to find cycle markers.

## Lifecycle and limits

- The server starts exactly one child process and never restarts it in v1.
- If it exits, pending waits fail with its exit code or signal and final output.
- On MCP shutdown, `SIGINT`, or `SIGTERM`, the server stops the child. On Unix,
  it stops the process group too, so package-manager children do not remain.
- Output before TypeScript's first watch-start marker is treated as startup
  output, not as a completed build.

## Manual check with MCP Inspector

Build the server, then launch the Inspector with a real project command:

```sh
pnpm build
pnpm dlx @modelcontextprotocol/inspector node /absolute/path/to/tsc-watch-mcp/dist/index.js --cwd /absolute/path/to/repo -- pnpm exec tsc --watch --pretty false --preserveWatchOutput
```

In the Inspector, call `get_tsc_status` until the initial build completes. Copy
`latestCompletedBuild`, make a TypeScript edit, then call `await_tsc_build` with
that value as `afterBuild`.
