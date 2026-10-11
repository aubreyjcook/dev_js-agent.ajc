/**
 * Command-line options.
 *
 * Hand-rolled rather than pulled in as a dependency: there are eight flags, and
 * keeping the parser here means the accepted surface is visible in one file.
 */

/** Where an option gets its value. */
type ValueKind = 'none' | 'string' | 'number' | 'enum';

interface OptionSpec {
  name: string;
  kind: ValueKind;
  /** For `enum` options. */
  values?: readonly string[];
  help: string;
  /** Shown after the option name in `--help`. */
  placeholder?: string;
}

export interface CliConfig {
  /** Start with the real keyboard and mouse driver. */
  live: boolean;
  /** Duration of a cursor move, in ms. */
  moveDurationMs: number;
  /** Delay after each key press, in ms. */
  keyDelayMs: number;
  /** Delay after each typed character, in ms. */
  charDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Commands to run non-interactively, then exit. */
  exec: string[];
  help: boolean;
}

const OPTIONS: readonly OptionSpec[] = [
  { name: 'live', kind: 'none', help: 'drive the real keyboard and mouse (default: dry run)' },
  { name: 'dry-run', kind: 'none', help: 'force the recording driver, overriding --live' },
  {
    name: 'log-level',
    kind: 'enum',
    values: ['debug', 'info', 'warn', 'error'],
    placeholder: '<level>',
    help: 'verbosity of the logger',
  },
  {
    name: 'speed',
    kind: 'number',
    placeholder: '<px-per-second>',
    help: 'cursor speed; higher is faster (default: 3000)',
  },
  {
    name: 'key-delay',
    kind: 'number',
    placeholder: '<ms>',
    help: 'pause after each key press',
  },
  {
    name: 'char-delay',
    kind: 'number',
    placeholder: '<ms>',
    help: 'pause between typed characters',
  },
  {
    name: 'exec',
    kind: 'string',
    placeholder: '<command>',
    help: 'run a command, then exit; repeatable, runs in the order given',
  },
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

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith('-')) {
      throw new CliError(
        `Unexpected argument "${argument}". Commands go through --exec.`,
      );
    }

    const withoutDashes = argument.replace(/^--?/, '');
    const equals = withoutDashes.indexOf('=');
    const name = equals === -1 ? withoutDashes : withoutDashes.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : withoutDashes.slice(equals + 1);

    // Single-character names are accepted as short forms of the long ones.
    const spec = OPTIONS.find((option) => option.name === name);
    if (spec === undefined) {
      throw new CliError(`Unknown option "${argument}". Try --help.`);
    }
    if (seen.has(spec.name) && spec.name !== 'exec') {
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

    apply(config, spec, value);
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
    case 'exec':
      if (value === undefined || value.trim() === '') {
        throw new CliError('--exec needs a command to run.');
      }
      config.exec.push(value);
      return;
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
    'options:',
  ];
  for (const option of OPTIONS) {
    const flags = `  --${option.name}${option.placeholder !== undefined ? ` ${option.placeholder}` : ''}`;
    lines.push(flags.padEnd(width + 2) + option.help);
  }
  lines.push(
    '',
    'examples:',
    '  npm start                                  interactive, dry run (safe)',
    '  npm run live                               interactive, real input',
    '  npm start -- --exec "help"                 print help and exit',
    '  npm start -- --live --exec "press-key ctrl+l" --exec "type-text docs"',
    '',
  );
  return lines.join('\n');
}
