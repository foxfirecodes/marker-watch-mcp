export type WatchConfig = {
  command: string;
  args: string[];
  cwd: string;
  logFile?: string;
};

type ConfigEnvironment = Record<string, string | undefined>;

const ENV_COMMAND = "TSC_WATCH_MCP_COMMAND";
const ENV_ARGS = "TSC_WATCH_MCP_ARGS";
const ENV_CWD = "TSC_WATCH_MCP_CWD";
const ENV_LOG_FILE = "TSC_WATCH_MCP_LOG_FILE";
const SERVER_OPTIONS = new Set(["--command", "--args", "--cwd", "--log-file"]);

function readOption(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function parseArgs(value: string | undefined): string[] {
  if (value == null || value === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Watch args must be a JSON array of strings.");
  }

  if (!Array.isArray(parsed) || parsed.some(argument => typeof argument !== "string")) {
    throw new Error("Watch args must be a JSON array of strings.");
  }

  return parsed;
}

function readCommandAndArgs(argv: readonly string[]): string[] | undefined {
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (SERVER_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    positional.push(value);
  }

  if (positional.length === 0) return undefined;
  // Direct invocation retains the separator. The Inspector consumes that
  // separator, leaving the command as ordinary positional arguments; this
  // distinction keeps an underlying `pnpm exec -- tsc` intact.
  return positional[0] === "--" ? positional.slice(1) : positional;
}

/**
 * Reads the watch command from CLI flags first, then the environment.
 * `--args` and `TSC_WATCH_MCP_ARGS` are JSON arrays so every child argument
 * reaches spawn unchanged.
 */
export function readWatchConfig(
  argv: readonly string[] = process.argv.slice(2),
  environment: ConfigEnvironment = process.env,
): WatchConfig {
  const commandAndArgs = readCommandAndArgs(argv);
  if (commandAndArgs !== undefined && commandAndArgs.length === 0) {
    throw new Error("-- must be followed by a watch command.");
  }

  const command = commandAndArgs?.[0] ?? readOption(argv, "--command") ?? environment[ENV_COMMAND];
  if (command == null || command.trim() === "") {
    throw new Error(
      `A watch command is required. Pass --command or set ${ENV_COMMAND}.`,
    );
  }

  const args = commandAndArgs?.slice(1) ?? parseArgs(readOption(argv, "--args") ?? environment[ENV_ARGS]);
  const cwd = readOption(argv, "--cwd") ?? environment[ENV_CWD] ?? process.cwd();
  const logFile = readOption(argv, "--log-file") ?? environment[ENV_LOG_FILE];

  return {command, args, cwd, ...(logFile === undefined ? {} : {logFile})};
}
