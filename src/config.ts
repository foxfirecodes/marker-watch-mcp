export type MarkerWatchConfig = {
  command: string;
  args: string[];
  cwd: string;
  startMarker: string;
  endMarker: string;
  logFile?: string;
};

type ConfigEnvironment = Record<string, string | undefined>;

const ENV_COMMAND = "MARKER_WATCH_MCP_COMMAND";
const ENV_ARGS = "MARKER_WATCH_MCP_ARGS";
const ENV_CWD = "MARKER_WATCH_MCP_CWD";
const ENV_START_MARKER = "MARKER_WATCH_MCP_START_MARKER";
const ENV_END_MARKER = "MARKER_WATCH_MCP_END_MARKER";
const ENV_LOG_FILE = "MARKER_WATCH_MCP_LOG_FILE";
const SERVER_OPTIONS = new Set([
  "--command", "--args", "--cwd", "--start-marker", "--end-marker", "--log-file",
]);

function readOption(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseArgs(value: string | undefined): string[] {
  if (value == null || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(argument => typeof argument === "string")) return parsed;
  } catch {
    // Use the shared error below.
  }
  throw new Error("Command args must be a JSON array of strings.");
}

function readCommandAndArgs(argv: readonly string[]): string[] | undefined {
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (SERVER_OPTIONS.has(value)) index += 1;
    else positional.push(value);
  }
  if (positional.length === 0) return undefined;
  // Direct invocation keeps this separator; MCP Inspector consumes it before
  // launching the server, so an inner `pnpm exec -- command` stays intact.
  return positional[0] === "--" ? positional.slice(1) : positional;
}

function required(value: string | undefined, name: string): string {
  if (value == null || value === "") throw new Error(`${name} is required.`);
  return value;
}

/** Reads one marker-delimited long-running command from CLI flags or env. */
export function readMarkerWatchConfig(
  argv: readonly string[] = process.argv.slice(2),
  environment: ConfigEnvironment = process.env,
): MarkerWatchConfig {
  const commandAndArgs = readCommandAndArgs(argv);
  if (commandAndArgs !== undefined && commandAndArgs.length === 0) {
    throw new Error("-- must be followed by a command.");
  }
  const command = required(
    commandAndArgs?.[0] ?? readOption(argv, "--command") ?? environment[ENV_COMMAND],
    `A command (pass --command or set ${ENV_COMMAND})`,
  );
  const args = commandAndArgs?.slice(1) ?? parseArgs(readOption(argv, "--args") ?? environment[ENV_ARGS]);
  const cwd = readOption(argv, "--cwd") ?? environment[ENV_CWD] ?? process.cwd();
  const startMarker = required(
    readOption(argv, "--start-marker") ?? environment[ENV_START_MARKER],
    `A start marker (pass --start-marker or set ${ENV_START_MARKER})`,
  );
  const endMarker = required(
    readOption(argv, "--end-marker") ?? environment[ENV_END_MARKER],
    `An end marker (pass --end-marker or set ${ENV_END_MARKER})`,
  );
  const logFile = readOption(argv, "--log-file") ?? environment[ENV_LOG_FILE];
  return {command, args, cwd, startMarker, endMarker, ...(logFile === undefined ? {} : {logFile})};
}
