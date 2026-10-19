/**
 * Composition root.
 *
 * The one place where concrete implementations are chosen and wired. v0_02 moves
 * this out of the terminal's hands: `createApp` no longer builds a session,
 * because there are now two possible front ends and three possible modes. It
 * builds the *runtime* — agent, subroutines, task registry, command broker, event
 * bus — and lets `index.ts` decide what drives it.
 *
 * The additions relative to v0_01 are small on purpose:
 *
 *   - an `EventBus`, so "who wants to know?" is a list rather than a single
 *     registered observer
 *   - a `CommandBroker`, so the meaning of a command line is decided once
 *   - a logger `onRecord` hook, so log lines can be forwarded to clients
 *
 * Nothing in `core/` or `subroutines/` changed to make any of that work. If that
 * were not true, the architecture would have been wrong.
 *
 * If you are looking for "where does a new capability belong?":
 *   - it touches the operating system's input  -> `src/core`
 *   - it sequences agent primitives            -> `src/subroutines/builtin`
 *   - it is a new terminal verb                -> `src/terminal/commands.ts`
 *   - it is about clients, transport or service-> `src/daemon`
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DaemonSummary,
  InputDevice,
  Logger,
  LogRecord,
  RuntimeEvent,
  Subroutine,
} from './contract/index.js';
import { Agent } from './core/agent.js';
import { NutInputDevice } from './core/input/nut-input-device.js';
import { RecordingInputDevice } from './core/input/recording-input-device.js';
import { TaskRegistry } from './core/task-registry.js';
import { ConsoleLogger } from './logging/console-logger.js';
import { SubroutineRegistry } from './subroutines/registry.js';
import { builtinSubroutines } from './subroutines/builtin/index.js';
import type { CliConfig } from './cli/config.js';
import { EventBus } from './shared/event-bus.js';
import { CommandBroker } from './terminal/broker.js';

export interface CreateAppOptions {
  config: CliConfig;
  /** Version string for banners and the discovery file. */
  version: string;
  /** Extra subroutines to register alongside the built-ins. */
  subroutines?: readonly Subroutine[];
  /** Override the input device; mainly for tests. */
  device?: InputDevice;
  /** Lets `status` report the daemon; supplied by daemon mode only. */
  daemonStatus?: () => DaemonSummary | undefined;
  /** Also append log lines here. Detached daemons rely on this. */
  logFile?: string;
}

/** The assembled runtime, before any front end is attached. */
export interface App {
  readonly version: string;
  readonly live: boolean;
  readonly config: CliConfig;
  readonly agent: Agent;
  readonly subroutines: SubroutineRegistry;
  readonly tasks: TaskRegistry;
  readonly log: Logger;
  /** Everything the runtime wants the world to know. */
  readonly bus: EventBus<RuntimeEvent>;
  /** Executes command lines; shared by every front end. */
  readonly broker: CommandBroker;
  /** Stop all work and release the device. Idempotent. */
  shutdown(): Promise<void>;
}

/** Build the whole runtime, ready to be driven. */
export async function createApp(options: CreateAppOptions): Promise<App> {
  const { config } = options;

  // Order matters: the bus exists first, so the logger can publish into it.
  const bus = new EventBus<RuntimeEvent>();
  const log = createLogger(config, bus, options.logFile);

  const device = options.device ?? createDevice(config);
  const tasks = new TaskRegistry();
  const agent = new Agent({ device, tasks, logger: log });
  await agent.start();

  const subroutines = new SubroutineRegistry({
    agent,
    tasks,
    logger: log,
    subroutines: [...builtinSubroutines, ...(options.subroutines ?? [])],
  });

  // One observer, publishing to the bus. In v0_01 the terminal registered here
  // directly; now the interest may be local, remote, or both.
  tasks.observe((task) => bus.publish({ kind: 'task', task }));

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      // Order matters: cancel the work that drives the device, then close it.
      tasks.controller.cancel('Shutting down');
      await subroutines.stopAll('Shutting down');
      await agent.stop();
      log.debug('runtime stopped');
    })();
    return shuttingDown;
  };

  const broker = new CommandBroker({
    runtime: { agent, subroutines, tasks, log },
    ...(options.daemonStatus !== undefined ? { daemonStatus: options.daemonStatus } : {}),
  });

  return {
    version: options.version,
    live: agent.hostInfo().live,
    config,
    agent,
    subroutines,
    tasks,
    log,
    bus,
    broker,
    shutdown,
  };
}

/**
 * Build the logger, wiring two optional behaviours:
 *
 * - `onRecord` publishes every emitted record onto the bus, which is how remote
 *   clients see logs written by the daemon.
 * - `logFile` appends to a file as well as the console, because a detached
 *   daemon has no console to write to.
 */
function createLogger(
  config: CliConfig,
  bus: EventBus<RuntimeEvent>,
  logFile: string | undefined,
): Logger {
  const consoleSink = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const sink = logFile !== undefined ? makeFileSink(logFile, consoleSink) : consoleSink;

  return ConsoleLogger.create({
    level: config.logLevel,
    prefix: 'js-agent',
    sink,
    onRecord: (record: LogRecord) => {
      bus.publish({
        kind: 'log',
        record: {
          level: record.level,
          source: record.source,
          message: record.message,
          time: record.time.toISOString(),
        },
      });
    },
  });
}

/** Append to a file, tolerating a missing directory. Never throws. */
function makeFileSink(path: string, mirror: (line: string) => void): (line: string) => void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // If the directory cannot be created, appends will fail and be ignored.
  }
  return (line: string): void => {
    try {
      appendFileSync(path, `${line}\n`, 'utf8');
    } catch {
      // A log file that cannot be written must not stop the program.
    }
    mirror(line);
  };
}

/** Choose the live driver or the recording one, based on configuration. */
export function createDevice(config: CliConfig): InputDevice {
  if (!config.live) {
    return new RecordingInputDevice();
  }
  return new NutInputDevice({
    charDelayMs: config.charDelayMs,
    keyDelayMs: config.keyDelayMs,
  });
}

/** Read the version from package.json, falling back to `0.0.0-dev`. */
export function readVersion(): string {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      typeof (manifest as { version?: unknown }).version === 'string'
    ) {
      return (manifest as { version: string }).version;
    }
  } catch {
    // A missing or malformed manifest must not stop the program from running.
  }
  return '0.0.0-dev';
}
