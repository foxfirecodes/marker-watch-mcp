# marker-watch-mcp

`marker-watch-mcp` is an MCP server for one long-running command. It watches
that command's output for a start and end marker, then saves the enclosed
output as a numbered build result.

Use it when another tool already reruns your build or check command. This
server does not watch files or restart processes.

## Install

Node.js 20+ and pnpm are required.

```sh
pnpm install
pnpm build
pnpm link -g
```

Ensure pnpm's global bin directory is on your `PATH`, then configure your MCP
client to run the linked command:

```json
{
  "mcpServers": {
    "marker-watch": {
      "command": "marker-watch-mcp",
      "args": [
        "--cwd", "/absolute/path/to/project",
        "--start-marker", "@@build:start@@",
        "--end-marker", "@@build:end@@",
        "--",
        "your-watcher", "--", "your-check-command"
      ]
    }
  }
}
```

Everything after `--` is the command to run, with its arguments unchanged.
You can instead use `--command` and `--args`, or the corresponding
`MARKER_WATCH_MCP_*` environment variables. `--log-file /tmp/marker-watch.log`
keeps a raw output log.

## How it works

The command must stay running and write a start marker followed by an end
marker for each run. Markers match literal text in complete output lines after
terminal color codes are removed. The saved result keeps the original output.

The server keeps the latest 20 completed results. It exposes these MCP tools:

- `get_build_status` — current process and build state.
- `get_build` — a saved result; omit `version` for the latest.
- `await_build` — wait for the next result after a version.
- `start_build_wait` and `get_build_wait` — start and poll a non-blocking wait.
- `debug_get_live_output` — recent raw output for diagnosing a stuck run.

## Typical use

```text
get_build_status()                -> latestCompletedVersion: 41
edit files                        -> your watcher runs the check
await_build({ afterVersion: 41 }) -> version 42 and its output
```

For a long check, call `start_build_wait({ afterVersion: 41 })` and poll the
returned ID with `get_build_wait`.
