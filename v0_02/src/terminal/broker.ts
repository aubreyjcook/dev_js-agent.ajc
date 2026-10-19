/**
 * The command broker.
 *
 * In v0_01, `TerminalSession` did two jobs: it *rendered* the prompt, and it
 * *decided* what a command line meant. Those jobs were bundled because there was
 * exactly one caller.
 *
 * v0_02 has two callers — a local prompt and a daemon serving remote clients.
 * If each grew its own copy of "parse, look up builtin, validate subroutine,
 * run", they would drift, and a bug fixed in one would survive in the other. So
 * the decision-making moved here, and both front ends call {@link execute}.
 *
 * The broker is deliberately unaware of:
 *   - where the command came from (stdin or a socket)
 *   - how output is displayed (it is handed a sink)
 *   - whether a daemon exists (it may be told, for `status`)
 *
 * It is aware of one thing that matters: **commands are serialised**. With
 * several clients, two commands can otherwise interleave their output and read
 * half-applied state. See `AsyncQueue` for why this is cheap rather than
 * restrictive: it covers only the decision, not the long-running work a command
 * may start.
 */

import {
  type AgentStatusSource,
  type CommandResult,
  type DaemonSummary,
  type Logger,
  type SubroutineApi,
  type TaskSnapshot,
} from '../contract/index.js';
import { toError } from '../core/agent.js';
import type { TaskRegistry } from '../core/task-registry.js';
import { AsyncQueue } from '../shared/async-queue.js';
import { type CommandContext, findCommand } from './commands.js';
import { parseCommandLine } from './parse-command-line.js';

export interface BrokerRuntime {
  readonly agent: AgentStatusSource;
  readonly subroutines: SubroutineApi;
  readonly tasks: TaskRegistry;
  readonly log: Logger;
}

export interface BrokerOptions {
  runtime: BrokerRuntime;
  /**
   * Present in daemon mode. Lets `status` report the pid, endpoint and client
   * count without the command layer knowing what a daemon is.
   */
  daemonStatus?: () => DaemonSummary | undefined;
}

/** Where a command's textual output goes. */
export type OutputSink = (line: string) => void;

export interface DrainReport {
  /** `error` when any run since the marker finished badly. */
  result: CommandResult;
  failed: readonly TaskSnapshot[];
}

export class CommandBroker {
  readonly #runtime: BrokerRuntime;
  readonly #daemonStatus?: () => DaemonSummary | undefined;
  readonly #queue = new AsyncQueue();

  constructor(options: BrokerOptions) {
    this.#runtime = options.runtime;
    this.#daemonStatus = options.daemonStatus;
  }

  /** Commands currently waiting their turn. */
  get queued(): number {
    return this.#queue.pending;
  }

  /** Execute one line. Never rejects: failures come back as an `error` result. */
  execute(line: string, sink: OutputSink): Promise<CommandResult> {
    return this.#queue.run(() => this.#execute(line, sink));
  }

  /** Resolve once no subroutine or driver action is running. */
  async drain(): Promise<void> {
    await this.#runtime.tasks.whenIdle('subroutine');
    await this.#runtime.tasks.whenIdle('input');
  }

  /**
   * Drain, then report runs that failed since `since`.
   *
   * Used by scripted runs (`--exec`) so they can exit non-zero. The marker is
   * supplied by the caller because "since" differs: a local run starts at
   * process start, a daemon client starts when its connection was established.
   */
  async drainReport(since?: number): Promise<DrainReport> {
    await this.drain();
    if (since === undefined) return { result: { status: 'ok' }, failed: [] };

    const failed = this.#runtime.subroutines
      .recent({ since })
      .filter((task) => task.state === 'failed');
    if (failed.length === 0) return { result: { status: 'ok' }, failed };

    const detail = failed
      .map((task) => `${task.name}: ${task.error?.message ?? 'failed'}`)
      .join('; ');
    return {
      result: { status: 'error', message: `${failed.length} subroutine run(s) failed: ${detail}` },
      failed,
    };
  }

  // -- internals ------------------------------------------------------------

  async #execute(line: string, sink: OutputSink): Promise<CommandResult> {
    const parsed = parseCommandLine(line);
    if (parsed.name === '') return { status: 'empty' };

    let exitRequested = false;
    let shutdownRequested = false;

    const context = this.#createContext(sink, {
      onExit: () => {
        exitRequested = true;
      },
      onShutdown: () => {
        shutdownRequested = true;
      },
    });

    const builtin = findCommand(parsed.name);
    if (builtin !== undefined) {
      try {
        await builtin.run(context, parsed.args);
      } catch (error) {
        return { status: 'error', message: toError(error).message };
      }
    } else {
      if (this.#runtime.subroutines.get(parsed.name) === undefined) {
        return {
          status: 'error',
          message:
            `Unknown command or subroutine "${parsed.name}". ` +
            `Try \`help\`, or \`help ${parsed.name}\` for details.`,
        };
      }

      // Synchronous validation: the caller learns about a bad invocation
      // immediately, rather than after a run that may last minutes.
      const prepared = this.#runtime.subroutines.prepareRun(parsed.name, parsed.args);
      if (!prepared.ok) return { status: 'error', message: prepared.message };

      // Fire and forget: starting a run must not block the prompt, or `stop`
      // could not be typed while something is working.
      void this.#runtime.subroutines.start(prepared.run).catch((error: unknown) => {
        this.#runtime.log
          .child(parsed.name)
          .error(`background run failed: ${toError(error).message}`);
      });
    }

    if (shutdownRequested) return { status: 'shutdown' };
    if (exitRequested) return { status: 'exit' };
    return { status: 'ok' };
  }

  #createContext(
    sink: OutputSink,
    hooks: { onExit: () => void; onShutdown: () => void },
  ): CommandContext {
    const daemon = this.#daemonStatus?.();
    return {
      agent: this.#runtime.agent,
      subroutines: this.#runtime.subroutines,
      write: sink,
      requestExit: hooks.onExit,
      requestShutdown: hooks.onShutdown,
      log: this.#runtime.log,
      ...(daemon !== undefined ? { daemon } : {}),
    };
  }
}
