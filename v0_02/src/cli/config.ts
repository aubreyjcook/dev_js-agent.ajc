/**
 * Command-line options.
 *
 * v0_01 had eight flags and one question: how fast, and where should input go.
 * v0_02 adds a second axis — *how should the program run* — and with it the
 * chance to create contradictory instructions (`--detach` without a daemon,
 * `--port` and `--endpoint` at once, two different `--mode` flags).
 *
 * Those contradictions are rejected here, before anything starts. A CLI that
 * silently prefers one flag over another is a CLI whose users cannot predict it.
 */

/** How the program was asked to run. */
export const RUN_MODES = ['standalone', 'daemon', 'attach'] as const;
export type RunMode = (typeof RUN_MODES)[number];

type ValueKind = 'none' | 'string' | 'number' | 'enum';

interface OptionSpec {
  name: string;
  kind: ValueKind;
  values?: readonly string[];
  help: string;
  placeholder?: string;
}

export interface CliConfig {
  /** Start with the real keyboard and mouse driver. */
  live: boolean;
  moveDurationMs: number;
  keyDelayMs: number;
  charDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Commands to run non-interactively, then exit. */
  exec: string[];
  help: boolean;
  /** Explicit mode; when absent the user is asked (or a default is applied). */
  mode?: RunMode;
  /** Override the state directory (discovery file, sockets, logs). */
  stateDir?: string;
  /** Explicit local endpoint path. */
  endpoint?: string;
  /** Loopback TCP port instead of a local socket. `0` = OS chooses. */
  port?: number;
  /** Start the daemon in the background and return immediately. */
  detach: boolean;
  /** Stop a running daemon and exit. */
  stopDaemon: boolean;
  /** Do not wait for background work before exiting (`--exec`). */
  noWait: boolean;
  /**
   * Ask for a mode even when stdin is not a terminal.
   *
   * Exists because the chooser is the primary UX but is otherwise unreachable
   * without a TTY — which makes it untestable and awkward to drive from an
   * embedding. It is also genuinely useful when piping an answer in.
   */
  ask: boolean;
  /** Also write log lines to this file (daemon mode). */
  logFile?: string;
}

const OPTIONS: readonly OptionSpec[] = [
  { name: 'mode', kind: 'enum', values: RUN_MODES, placeholder: '<mode>', help: 'standalone, daemon or attach' },
  { name: 'standalone', kind: 'none', help: 'shorthand for --mode standalone' },
  { name: 'daemon', kind: 'none', help: 'shorthand for --mode daemon' },
  { name: 'attach', kind: 'none', help: 'shorthand for --mode attach' },
  { name: 'detach', kind: 'none', help: 'with daemon mode: run in the background and return' },
  { name: 'stop-daemon', kind: 'none', help: 'stop a running daemon, then exit' },
  { name: 'no-wait', kind: 'none', help: 'with --exec: return without waiting for background work' },
  { name: 'ask', kind: 'none', help: 'ask for a mode even when stdin is not a terminal' },
  { name: 'state-dir', kind: 'string', placeholder: '<path>', help: 'where the discovery file and sockets live' },
  { name: 'endpoint', kind: 'string', placeholder: '<path>', help: 'explicit pipe/socket path instead of the default' },
  { name: 'port', kind: 'number', placeholder: '<n>', help: 'use loopback TCP on this port (0 = choose one)' },
  { name: 'log-file', kind: 'string', placeholder: '<path>', help: 'also write logs to this file' },
  { name: 'live', kind: 'none', help: 'drive the real keyboard and mouse (default: dry run)' },
  { name: 'dry-run', kind: 'none', help: 'force the recording driver, overriding --live' },
  { name: 'log-level', kind: 'enum', values: ['debug', 'info', 'warn', 'error'], placeholder: '<level>', help: 'verbosity of the logger' },
  { name: 'speed', kind: 'number', placeholder: '<px-per-second>', help: 'cursor speed; higher is faster' },
  { name: 'key-delay', kind: 'number', placeholder: '<ms>', help: 'pause after each key press' },
  { name: 'char-delay', kind: 'number', placeholder: '<ms>', help: 'pause between typed characters' },
  { name: 'exec', kind: 'string', placeholder: '<command>', help: 'run a command, then exit; repeatable' },
  { name: 'help', kind: 'none', help: 'show this message' },
];

const DEFAULTS: CliConfig = {
  live: false,
  moveDurationMs: 260,
  keyDelayMs: 40,
  charDelayMs: 28,
  logLevel: 'info',
  exec: [],
  help: false,
  detach: false,
  stopDaemon: false,
  noWait: false,
  ask: false,
};

/** Raised for a malformed command line, so `index.ts` can exit with code 2. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Parse `process.argv`-style arguments, including `--opt=value` forms. */
export function parseCliArgs(argv: readonly string[]): CliConfig {
  const config: CliConfig = { ...DEFAULTS, exec: [] };
  const seen = new Set<string>();
  const modeRequests = new Set<RunMode>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith('-')) {
      throw new CliError(`Unexpected argument "${argument}". Commands go through --exec.`);
    }

    const withoutDashes = argument.replace(/^--?/, '');
    const equals = withoutDashes.indexOf('=');
    const name = equals === -1 ? withoutDashes : withoutDashes.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : withoutDashes.slice(equals + 1);

    const spec = OPTIONS.find((option) => option.name === name);
    if (spec === undefined) {
      throw new CliError(`Unknown option "${argument}". Try --help.`);
    }

    // Mode flags are exempt from the "given twice" check: repeating one is
    // harmless, and two *different* ones are reported as a conflict below, which
    // is a better message than "given more than once".
    const isModeFlag =
      spec.name === 'mode' ||
      spec.name === 'standalone' ||
      spec.name === 'daemon' ||
      spec.name === 'attach';

    if (seen.has(spec.name) && spec.name !== 'exec' && !isModeFlag) {
      throw new CliError(`Option --${spec.name} was given more than once.`);
    }
    seen.add(spec.name);

    let value = inlineValue;
    if (spec.kind !== 'none' && value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError(`Option --${spec.name} needs a value.`);
      }
      value = next;
      index += 1;
    }

    // Mode can arrive three ways; collect requests so conflicts are caught.
    if (isModeFlag) {
      const requested = spec.name === 'mode' ? value : spec.name;
      if (requested === undefined || !RUN_MODES.includes(requested as RunMode)) {
        throw new CliError(`--mode must be one of ${RUN_MODES.join(', ')}; got "${requested}".`);
      }
      modeRequests.add(requested as RunMode);
      continue;
    }

    apply(config, spec, value);
  }

  if (modeRequests.size > 1) {
    throw new CliError(
      `Conflicting modes requested (${[...modeRequests].join(', ')}). Choose one.`,
    );
  }
  const requestedMode = [...modeRequests][0];
  if (requestedMode !== undefined) config.mode = requestedMode;

  // `--detach` is only meaningful for a daemon; implying it is friendlier than
  // refusing, but explicitly asking for another mode is a mistake worth naming.
  if (config.detach) {
    if (config.mode !== undefined && config.mode !== 'daemon') {
      throw new CliError(`--detach only makes sense with daemon mode, not "${config.mode}".`);
    }
    config.mode ??= 'daemon';
  }

  if (config.endpoint !== undefined && config.port !== undefined) {
    throw new CliError('Use either --endpoint or --port, not both.');
  }
  if (config.stopDaemon && config.exec.length > 0) {
    throw new CliError('--stop-daemon and --exec cannot be combined.');
  }
  // --dry-run wins over --live, whichever order they appear in.
  if (seen.has('dry-run')) config.live = false;

  return config;
}

function apply(config: CliConfig, spec: OptionSpec, value: string | undefined): void {
  switch (spec.name) {
    case 'live':
      config.live = true;
      return;
    case 'dry-run':
      config.live = false;
      return;
    case 'help':
      config.help = true;
      return;
    case 'detach':
      config.detach = true;
      return;
    case 'stop-daemon':
      config.stopDaemon = true;
      return;
    case 'no-wait':
      config.noWait = true;
      return;
    case 'ask':
      config.ask = true;
      return;
    case 'exec':
      if (value === undefined || value.trim() === '') {
        throw new CliError('--exec needs a command to run.');
      }
      config.exec.push(value);
      return;
    case 'state-dir':
      config.stateDir = required(spec, value);
      return;
    case 'endpoint':
      config.endpoint = required(spec, value);
      return;
    case 'log-file':
      config.logFile = required(spec, value);
      return;
    case 'port': {
      const port = Number(required(spec, value));
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new CliError(`--port must be an integer between 0 and 65535; got "${value}".`);
      }
      config.port = port;
      return;
    }
    case 'log-level': {
      const level = value as CliConfig['logLevel'];
      if (spec.values?.includes(level) !== true) {
        throw new CliError(
          `--log-level must be one of ${spec.values?.join(', ')}; got "${value}".`,
        );
      }
      config.logLevel = level;
      return;
    }
    case 'key-delay':
      config.keyDelayMs = positiveNumber(spec, value);
      return;
    case 'char-delay':
      config.charDelayMs = positiveNumber(spec, value);
      return;
    case 'speed':
      config.moveDurationMs = speedToDuration(positiveNumber(spec, value));
      return;
    default:
      return;
  }
}

function required(spec: OptionSpec, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new CliError(`--${spec.name} needs a value.`);
  }
  return value;
}

function positiveNumber(spec: OptionSpec, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`--${spec.name} needs a non-negative number; got "${value}".`);
  }
  return parsed;
}

/**
 * Turn a cursor speed into a move duration.
 *
 * The agent works in "how long should this move take", while a speed in
 * pixels/second is easier to reason about, so the conversion lives here rather
 * than in the driver.
 */
export function speedToDuration(pxPerSecond: number): number {
  if (pxPerSecond <= 0) {
    throw new CliError('--speed must be greater than 0.');
  }
  const referenceDistance = 800;
  return Math.round((referenceDistance / pxPerSecond) * 1_000);
}

/** `--help` text. */
export function renderCliHelp(): string {
  const width = Math.max(
    ...OPTIONS.map((option) => option.name.length + (option.placeholder?.length ?? 0) + 4),
  );
  const lines = [
    'js-agent — a Node.js agent with a keyboard/mouse core and swappable subroutines.',
    '',
    'usage: npm start -- [options]',
    '',
    'modes:',
    '  standalone   this terminal owns the keyboard and mouse (default)',
    '  daemon       one process owns them; any terminal can send commands',
    '  attach       send commands to a running daemon',
    '',
    'options:',
  ];
  for (const option of OPTIONS) {
    const flags = `  --${option.name}${option.placeholder !== undefined ? ` ${option.placeholder}` : ''}`;
    lines.push(flags.padEnd(width + 2) + option.help);
  }
  lines.push(
    '',
    'examples:',
    '  npm start                                              choose a mode interactively',
    '  npm start -- --mode standalone                          local prompt, dry run',
    '  npm start -- --mode daemon --detach                     background service',
    '  npm start -- --mode attach                              prompt, driving the daemon',
    '  npm start -- --mode attach --exec "list"                one command, then exit',
    '  npm start -- --stop-daemon                              stop the running daemon',
    '  npm start -- --mode daemon --port 0 --state-dir ./tmp   isolated daemon (tests)',
    '',
  );
  return lines.join('\n');
}
