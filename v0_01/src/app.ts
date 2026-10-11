/**
 * Composition root.
 *
 * The only place in the program where the two halves are introduced to each
 * other. It picks a driver, builds the shared task registry, hands that same
 * registry to both the agent and the subroutine registry, and returns something
 * the terminal can drive.
 *
 * If you are looking for "where does a new capability belong?", this is the file
 * that answers it:
 *   - it touches the operating system's input  -> `src/core`
 *   - it sequences agent primitives            -> `src/subroutines/builtin`
 *   - it is a new terminal verb                -> `src/terminal/commands.ts`
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InputDevice, Subroutine } from './contract/index.js';
import { Agent } from './core/agent.js';
import { NutInputDevice } from './core/input/nut-input-device.js';
import { RecordingInputDevice } from './core/input/recording-input-device.js';
import { TaskRegistry } from './core/task-registry.js';
import { ConsoleLogger } from './logging/console-logger.js';
import { SubroutineRegistry } from './subroutines/registry.js';
import { builtinSubroutines } from './subroutines/builtin/index.js';
import type { CliConfig } from './cli/config.js';
import { TerminalSession } from './terminal/session.js';

export interface CreateRuntimeOptions {
  config: CliConfig;
  /** Version string for the banner. */
  version: string;
  /** Extra subroutines to register alongside the built-ins. */
  subroutines?: readonly Subroutine[];
  /** Override the input device; mainly for tests. */
  device?: InputDevice;
}

/** The assembled program. */
export interface App {
  readonly version: string;
  readonly live: boolean;
  readonly config: CliConfig;
  readonly agent: Agent;
  readonly subroutines: SubroutineRegistry;
  readonly tasks: TaskRegistry;
  readonly session: TerminalSession;
  /** Stop all work and release the input device. */
  shutdown(): Promise<void>;
}

/** Build the whole program, ready to run. */
export async function createApp(options: CreateRuntimeOptions): Promise<App> {
  const { config } = options;
  const log = ConsoleLogger.create({ level: config.logLevel, prefix: 'js-agent' });

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

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    // Idempotent: SIGINT during an `exit` command must not double-close things.
    shuttingDown ??= (async () => {
      // Order matters: cancel the work that drives the device, then close it.
      tasks.controller.cancel('Shutting down');
      await subroutines.stopAll('Shutting down');
      await agent.stop();
      log.debug('runtime stopped');
    })();
    return shuttingDown;
  };

  const session = new TerminalSession({
    runtime: { agent, subroutines, tasks, log, shutdown },
    version: options.version,
    live: agent.hostInfo().live,
    logLevel: config.logLevel,
  });

  return {
    version: options.version,
    live: agent.hostInfo().live,
    config,
    agent,
    subroutines,
    tasks,
    session,
    shutdown,
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
