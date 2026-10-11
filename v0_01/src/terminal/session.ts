/**
 * The interactive terminal.
 *
 * This is the front end: it reads a line, decides whether it names a built-in
 * command or a subroutine, runs it, and renders the answer. It owns the prompt
 * loop and the shutdown sequence, and it is the only place that knows about
 * both halves at once.
 *
 * Two modes:
 *   - `runInteractive()`  a prompt loop, for a person at a keyboard;
 *   - `runOnce(lines)`    run some commands and return, for scripts and tests.
 * Both go through the same {@link TerminalSession.dispatch}, so behaviour cannot
 * drift between them.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type {
  AgentHostSource,
  AgentStatusSource,
  Logger,
  SubroutineApi,
} from '../contract/index.js';
import type { TaskRegistry } from '../core/task-registry.js';
import { isInteractive, renderBanner } from './banner.js';
import { commandNames, findCommand, type CommandContext } from './commands.js';
import { parseCommandLine } from './parse-command-line.js';

export interface TerminalRuntime {
  /**
   * The terminal's narrow, read-only view of the agent.
   *
   * Both the banner (needs `hostInfo`) and the `status` command (needs `status`)
   * read the agent, but neither may send input.
   */
  readonly agent: AgentStatusSource & AgentHostSource;
  /** The subroutine catalogue and the runner for it. */
  readonly subroutines: SubroutineApi;
  /** Reads the cancellation signals subroutines are checked against. */
  readonly tasks: TaskRegistry;
  readonly log: Logger;
  /** Cancel every task, stop the subroutines, release the input device. */
  shutdown(): Promise<void>;
}

export interface TerminalSessionOptions {
  /** The pieces of the program this session drives. */
  runtime: TerminalRuntime;
  /** Version shown in the banner. */
  version: string;
  /** True when input reaches the real keyboard and mouse. */
  live: boolean;
  /** Logger threshold, shown in the banner. */
  logLevel: string;
  /** Where user-facing text goes. Defaults to `process.stdout`. */
  write?: (line: string) => void;
  /** Where errors go. Defaults to the same stream as `write`. */
  writeError?: (line: string) => void;
}

const PROMPT = 'js-agent> ';
/** How long to let in-flight work unwind during shutdown before giving up. */
const SHUTDOWN_GRACE_MS = 2_000;

/** Result of one `dispatch`, so non-interactive callers can set an exit code. */
export type DispatchStatus = 'ok' | 'empty' | 'exit' | 'error';

export class TerminalSession {
  readonly #runtime: TerminalRuntime;
  readonly #version: string;
  readonly #live: boolean;
  readonly #logLevel: string;
  readonly #write: (line: string) => void;
  readonly #writeError: (line: string) => void;

  #rl?: ReadlineInterface;
  #exitRequested = false;
  #closed = false;
  #busy = false;
  /** True while a prompt is displayed, so async output can erase it first. */
  #promptVisible = false;
  #shuttingDown = false;
  #onExit?: () => void;
  readonly #pending: string[] = [];

  constructor(options: TerminalSessionOptions) {
    this.#runtime = options.runtime;
    this.#version = options.version;
    this.#live = options.live;
    this.#logLevel = options.logLevel;
    const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.#write = sink;
    this.#writeError = options.writeError ?? sink;
  }

  // -- entry points ---------------------------------------------------------

  /** Read commands from the terminal until `exit`. Returns a process exit code. */
  async runInteractive(): Promise<number> {
    for (const line of renderBanner(this.#runtime.agent, {
      version: this.#version,
      live: this.#live,
      logLevel: this.#logLevel,
      commands: commandNames().sort(),
      subroutines: this.#runtime.subroutines.list().map((subroutine) => subroutine.name),
    })) {
      this.#write(line);
    }

    if (!isInteractive()) {
      this.#writeError(
        'stdin is not a TTY, so there is nothing to read. ' +
          'Use --exec "<command>" to run commands non-interactively.',
      );
      return 2;
    }

    // `terminal: false` keeps readline from drawing its own prompt, so the
    // banner, command output and asynchronous progress lines stay in order.
    this.#rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    this.#rl.on('line', (line) => {
      if (this.#closed) return;
      // Commands are serialised by the pump, so a line arriving while a command
      // runs simply waits its turn.
      this.#pending.push(line);
      void this.#pump();
    });
    this.#rl.on('close', () => {
      const wasClosing = this.#closed;
      this.#closed = true;
      if (!wasClosing) {
        this.#write('');
        this.#requestExit('input closed');
      }
    });
    this.#installObservers();

    const finished = new Promise<void>((resolve) => {
      this.#onExit = resolve;
    });

    this.#prompt();
    await finished;
    await this.#teardown();
    return 0;
  }

  /**
   * Run lines from argv, then shut down. Used by `--exec` and by tests.
   *
   * Unlike the interactive path, this one *does* wait for subroutines and
   * reports their failures, because a non-interactive caller has no other way to
   * learn the outcome — and a script that silently swallows a failed action is
   * worse than one that fails loudly.
   */
  async runOnce(lines: readonly string[]): Promise<number> {
    this.#write(
      `js-agent ${this.#version} · ${this.#live ? 'LIVE input' : 'dry run'} · ` +
        `driver ${this.#live ? 'nut-js' : 'recorder'}`,
    );
    this.#installObservers();

    let code = 0;
    // Bounded to this run, so a long-lived process cannot re-report old work.
    const since = Date.now();

    for (const [index, line] of lines.entries()) {
      const { status } = await this.dispatch(line);
      if (status === 'error') code = 1;

      // A scripted sequence means "do this, then this", so settle before moving
      // on: otherwise `--exec "move-mouse …" --exec status` would report the
      // cursor from before the move it just asked for.
      //
      // The exception is a `stop` coming next — it must be able to interrupt
      // something that is still running, which is the whole point of it.
      const next = lines[index + 1];
      const stoppingNext = next !== undefined && parseCommandLine(next).name === 'stop';
      if (!stoppingNext) await this.#drain();
    }

    const failed = this.#runtime.subroutines
      .recent({ since })
      .filter((task) => task.state === 'failed');
    if (failed.length > 0) {
      this.#writeError(`${failed.length} subroutine run(s) failed:`);
      for (const task of failed) {
        const reason = task.error !== undefined ? `: ${task.error.message}` : '';
        this.#writeError(`  ${task.id} ${task.name}${reason}`);
      }
      code = 1;
    }

    await this.#teardown();
    return code;
  }

  /**
   * Wait until nothing is running.
   *
   * Subroutines and their driver actions are started in the background, so any
   * caller that needs a settled view of the world must wait for both.
   */
  async #drain(): Promise<void> {
    await this.#runtime.tasks.whenIdle('subroutine');
    await this.#runtime.tasks.whenIdle('input');
  }

  /** Run one line. Never throws; failures come back as a status of `error`. */
  async dispatch(line: string): Promise<{ status: DispatchStatus; message?: string }> {
    const trimmed = line.trim();
    if (trimmed === '') return { status: 'empty' };

    const parsed = parseCommandLine(trimmed);
    if (parsed.name === '') return { status: 'empty' };

    const builtin = findCommand(parsed.name);

    if (builtin !== undefined) {
      try {
        await builtin.run(this.#context(), parsed.args);
      } catch (error) {
        const message = toMessage(error);
        this.#writeError(message);
        return { status: 'error', message };
      }
      return this.#exitRequested ? { status: 'exit' } : { status: 'ok' };
    }

    if (this.#runtime.subroutines.get(parsed.name) === undefined) {
      const message =
        `Unknown command or subroutine "${parsed.name}". ` +
        'Try `help`, or `help ' + parsed.name + '` for details.';
      this.#writeError(message);
      return { status: 'error', message };
    }

    // A subroutine is validated synchronously before it starts, so a mistake at
    // the prompt is reported as a failure of *this* command rather than
    // vanishing into a background task.
    const prepared = this.#runtime.subroutines.prepareRun(parsed.name, parsed.args);
    if (!prepared.ok) {
      this.#writeError(prepared.message);
      return { status: 'error', message: prepared.message };
    }

    // Deliberately not awaited: a long-running subroutine must not block the
    // prompt, so `list` and `stop` stay responsive while it works.
    void this.#runtime.subroutines.start(prepared.run).catch((error: unknown) => {
      this.#writeError(toMessage(error));
    });
    return { status: 'ok' };
  }

  /** Route a SIGINT through the normal exit path instead of killing the process. */
  interrupt(): void {
    this.#write('');
    this.#write('Interrupted — `stop` halts subroutines, `exit` quits.');
    this.#requestExit('interrupt');
  }

  // -- internals ------------------------------------------------------------

  /**
   * The agent, narrowed to what the commands need.
   *
   * `commands.ts` only asks for a name, a ready flag and a status snapshot, so
   * the terminal does not depend on the whole `Agent` class.
   */
  #agentView(): CommandContext['agent'] {
    return this.#runtime.agent;
  }
  #context(): CommandContext {
    return {
      agent: this.#agentView(),
      subroutines: this.#runtime.subroutines,
      write: this.#write,
      requestExit: () => this.#requestExit('exit command'),
      log: this.#runtime.log,
    };
  }

  #requestExit(reason: string): void {
    if (!this.#exitRequested) {
      this.#exitRequested = true;
      this.#runtime.log.debug(`exit requested (${reason})`);
    }
    this.#onExit?.();
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#shuttingDown) return;
    this.#busy = true;
    try {
      while (this.#pending.length > 0 && !this.#exitRequested) {
        const next = this.#pending.shift();
        if (next === undefined) break;
        await this.dispatch(next);
      }
      // Anything still queued when we are leaving is stale.
      if (this.#exitRequested) this.#pending.length = 0;
    } finally {
      this.#busy = false;
      this.#prompt();
    }
  }

  /** Show the prompt, if there is a person there to see it. */
  #prompt(): void {
    if (this.#exitRequested || this.#closed || this.#busy) return;
    if (!isInteractive() || this.#promptVisible) return;
    this.#promptVisible = true;
    process.stdout.write(PROMPT);
  }

  /**
   * Print subroutine progress as it happens.
   *
   * Reported in both modes: in an interactive session the prompt is closed off
   * first so output cannot land on the same line as the `js-agent> ` marker, and
   * in a scripted run these lines are the only sign of progress during a long
   * subroutine.
   */
  #installObservers(): void {
    this.#runtime.tasks.observe((snapshot) => {
      if (snapshot.kind !== 'subroutine') return;
      if (this.#shuttingDown) return;

      const detail = snapshot.detail !== undefined ? ` · ${snapshot.detail}` : '';
      const line = `[${snapshot.id}] ${snapshot.name}: ${snapshot.state}${detail}`;
      this.#closePrompt();
      this.#write(line);
      this.#prompt();
    });
  }

  #closePrompt(): void {
    if (!this.#promptVisible) return;
    process.stdout.write('\n');
    this.#promptVisible = false;
  }

  async #teardown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#closePrompt();
    this.#rl?.close();

    const active = this.#runtime.tasks.active();
    if (active.length > 0) {
      this.#write(`Stopping ${active.length} task(s)…`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
    });

    try {
      const outcome = await Promise.race([
        this.#runtime.shutdown().then(() => 'done' as const),
        grace,
      ]);
      if (outcome === 'timeout') {
        this.#write('Shutdown is taking too long; exiting anyway.');
      }
    } catch (error) {
      this.#writeError(`Shutdown reported: ${toMessage(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      process.stdin.pause();
    }
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
