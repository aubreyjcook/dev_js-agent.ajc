/**
 * The local front end: a prompt in this process.
 *
 * This is the v0_01 terminal with two things moved out:
 *
 * - **Deciding what a command means** moved to `CommandBroker`, because a second
 *   front end now needs the same behaviour.
 * - **Knowing about the runtime's internals** moved out too: this class talks to
 *   a broker and an event bus, so it cannot accidentally type on your keyboard.
 *
 * What remains is genuinely session-specific: reading a line, drawing a prompt,
 * deciding what `exit` means *here*, and tearing down.
 *
 * Note the one asymmetry with the remote session. When this session ends, the
 * program ends, so `exit` must stop work and release the device. In a remote
 * session, `exit` must only detach. That is why the broker reports `exit` and
 * `shutdown` as distinct outcomes and lets each front end interpret them.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type {
  AgentHostSource,
  CommandResult,
  Logger,
  RuntimeEvent,
  SubroutineApi,
} from '../contract/index.js';
import type { EventBus } from '../shared/event-bus.js';
import { isInteractive, renderBanner } from './banner.js';
import { commandNames } from './commands.js';
import { parseCommandLine } from './parse-command-line.js';
import { renderTaskEvent } from './render.js';
import type { CommandBroker } from './broker.js';

export interface LocalSessionOptions {
  agent: AgentHostSource;
  broker: CommandBroker;
  subroutines: SubroutineApi;
  bus: EventBus<RuntimeEvent>;
  log: Logger;
  /** Cancel work, stop the agent, release the device. Idempotent. */
  shutdown: () => Promise<void>;
  version: string;
  live: boolean;
  logLevel: string;
  /** Skip waiting for background work during `--exec`. */
  noWait?: boolean;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

const PROMPT = 'js-agent> ';
/** Time allowed for work to unwind during shutdown before exiting anyway. */
const SHUTDOWN_GRACE_MS = 2_000;

export class LocalSession {
  readonly #options: LocalSessionOptions;
  readonly #write: (line: string) => void;
  readonly #writeError: (line: string) => void;

  #rl?: ReadlineInterface;
  #exitRequested = false;
  #closed = false;
  #busy = false;
  #promptVisible = false;
  #shuttingDown = false;
  #onExit?: () => void;
  #unsubscribe?: () => void;
  readonly #pending: string[] = [];

  constructor(options: LocalSessionOptions) {
    this.#options = options;
    const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.#write = sink;
    this.#writeError = options.writeError ?? sink;
  }

  // -- entry points ---------------------------------------------------------

  /** Read commands from the terminal until `exit`. Returns a process exit code. */
  async runInteractive(): Promise<number> {
    const options = this.#options;
    for (const line of renderBanner(options.agent, {
      version: options.version,
      mode: 'standalone',
      live: options.live,
      logLevel: options.logLevel,
      commands: commandNames().sort(),
      subroutines: options.subroutines.list().map((subroutine) => subroutine.name),
    })) {
      this.#write(line);
    }

    this.#installObservers();

    if (!isInteractive()) {
      this.#writeError(
        'stdin is not a TTY, so there is nothing to read. ' +
          'Use --exec "<command>" to run commands non-interactively.',
      );
      await this.#teardown();
      return 2;
    }

    // `terminal: false` keeps readline from drawing its own prompt, so banners,
    // command output and asynchronous progress lines stay in order.
    this.#rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    this.#rl.on('line', (line) => {
      if (this.#closed) return;
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

    const finished = new Promise<void>((resolve) => {
      this.#onExit = resolve;
    });

    this.#prompt();
    await finished;
    await this.#teardown();
    return 0;
  }

  /** Run lines from argv, then shut down. Used by `--exec` and by tests. */
  async runOnce(lines: readonly string[]): Promise<number> {
    const options = this.#options;
    this.#write(
      `js-agent ${options.version} · target 0.02 · standalone · ` +
        `${options.live ? 'LIVE input' : 'dry run'} · ` +
        `driver ${options.live ? 'nut-js' : 'recorder'}`,
    );
    this.#installObservers();

    let code = 0;
    const since = Date.now();

    for (const [index, line] of lines.entries()) {
      const result = await this.dispatch(line);
      if (result.status === 'error') {
        // The broker reports failures as data, so that a remote client can send
        // them over the wire. A local session is the one that prints them.
        if (result.message !== undefined) this.#writeError(result.message);
        code = 1;
      }
      if (result.status === 'exit' || result.status === 'shutdown') break;

      // A scripted sequence means "do this, then this", so settle before moving
      // on — except before `stop`, which exists to interrupt work in flight.
      // `--no-wait` opts out entirely, for fire-and-forget scripts.
      if (options.noWait === true) continue;
      const next = lines[index + 1];
      const stoppingNext = next !== undefined && parseCommandLine(next).name === 'stop';
      if (!stoppingNext) await this.#options.broker.drain();
    }

    if (options.noWait !== true) {
      const report = await this.#options.broker.drainReport(since);
      if (report.failed.length > 0) {
        this.#writeError(`${report.failed.length} subroutine run(s) failed:`);
        for (const task of report.failed) {
          const reason = task.error !== undefined ? `: ${task.error.message}` : '';
          this.#writeError(`  ${task.id} ${task.name}${reason}`);
        }
        code = 1;
      }
    }

    await this.#teardown();
    return code;
  }

  /** Run one line. Never throws; failures come back as an `error` result. */
  dispatch(line: string): Promise<CommandResult> {
    return this.#options.broker.execute(line, this.#write);
  }

  /** Route a SIGINT through the normal exit path instead of killing the process. */
  interrupt(): void {
    this.#write('');
    this.#write('Interrupted — `stop` halts subroutines, `exit` quits.');
    this.#requestExit('interrupt');
  }

  // -- internals ------------------------------------------------------------

  #requestExit(reason: string): void {
    if (!this.#exitRequested) {
      this.#exitRequested = true;
      this.#options.log.debug(`exit requested (${reason})`);
    }
    this.#rl?.close();
    this.#onExit?.();
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#shuttingDown) return;
    this.#busy = true;
    try {
      while (this.#pending.length > 0 && !this.#exitRequested) {
        const next = this.#pending.shift();
        if (next === undefined) break;
        const result = await this.dispatch(next);
        if (result.status === 'error' && result.message !== undefined) {
          this.#writeError(result.message);
        }
      }
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
   * Log events are deliberately *not* rendered here: the console logger already
   * writes them in this process, and printing them twice would be a regression.
   * A remote client has no such console, which is why it does render them.
   */
  #installObservers(): void {
    this.#unsubscribe = this.#options.bus.subscribe((event) => {
      if (event.kind !== 'task') return;
      if (event.task.kind !== 'subroutine') return;
      if (this.#shuttingDown) return;

      this.#closePrompt();
      this.#write(renderTaskEvent(event.task));
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
    this.#unsubscribe?.();
    this.#rl?.close();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([
        this.#options.shutdown().then(() => 'done' as const),
        grace,
      ]);
      if (outcome === 'timeout') {
        this.#write('Shutdown is taking too long; exiting anyway.');
      }
    } catch (error) {
      this.#writeError(
        `Shutdown reported: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      process.stdin.pause();
    }
  }
}
