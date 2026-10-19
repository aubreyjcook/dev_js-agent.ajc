/**
 * The remote front end: a prompt that talks to a daemon.
 *
 * It renders the same things as the local session, but the work happens
 * elsewhere, and that changes three behaviours in ways worth understanding:
 *
 * 1. **`exit` detaches; it does not stop anything.** Killing a shared daemon
 *    because one terminal closed would be a hostile surprise. `shutdown` exists
 *    for the explicit request.
 * 2. **Ctrl+C detaches too.** In v0_01 it stopped work, because that process
 *    owned the work. Here it must not reach across processes and cancel someone
 *    else's run; the user has `stop` for that, which is visible to everyone.
 * 3. **Log events are rendered.** A local session leaves logging to the process
 *    that owns it; a client has no such console, so the daemon forwards records
 *    over the wire and this session prints them.
 *
 * The rendering code is shared with the local session (`render.ts`), so the two
 * front ends cannot drift apart visually.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type { CommandResult, DaemonInfo } from '../contract/index.js';
import type { DaemonClient } from '../daemon/client.js';
import { isInteractive, renderAttachBanner } from './banner.js';
import { renderLogEvent, renderTaskEvent } from './render.js';

export interface RemoteSessionOptions {
  client: DaemonClient;
  info: DaemonInfo;
  version: string;
  /** Skip the final wait for the daemon to be idle. */
  noWait?: boolean;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

const PROMPT = 'js-agent (remote)> ';

export class RemoteSession {
  readonly #options: RemoteSessionOptions;
  readonly #client: DaemonClient;
  readonly #write: (line: string) => void;
  readonly #writeError: (line: string) => void;

  #rl?: ReadlineInterface;
  #exitRequested = false;
  #closed = false;
  #busy = false;
  #promptVisible = false;
  #onExit?: (reason?: string) => void;
  #unsubscribe?: () => void;
  readonly #pending: string[] = [];

  constructor(options: RemoteSessionOptions) {
    this.#options = options;
    this.#client = options.client;
    const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.#write = sink;
    this.#writeError = options.writeError ?? sink;
  }

  // -- entry points ---------------------------------------------------------

  async runInteractive(): Promise<number> {
    for (const line of renderAttachBanner(this.#options.info, this.#options.version)) {
      this.#write(line);
    }
    this.#installObservers();

    if (!isInteractive()) {
      this.#writeError(
        'stdin is not a TTY, so there is nothing to read. ' +
          'Use --attach --exec "<command>" to run commands non-interactively.',
      );
      this.#client.close();
      return 2;
    }

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
      this.#onExit = () => resolve();
    });
    this.#prompt();
    await finished;

    this.#teardown();
    return 0;
  }

  async runOnce(lines: readonly string[]): Promise<number> {
    this.#installObservers();
    this.#write(
      `js-agent ${this.#options.version} · target 0.02 · attach · ` +
        `daemon pid ${this.#options.info.pid} · ${this.#options.info.endpoint}`,
    );

    let code = 0;
    try {
      for (const line of lines) {
        const result = await this.#run(line);
        if (result.status === 'error') code = 1;
        if (result.status === 'exit' || result.status === 'shutdown') break;
      }

      // The work belongs to the daemon, so the only meaningful barrier is the
      // daemon's own notion of idle. `--no-wait` skips it, which is what makes
      // "start something and return" possible.
      if (!this.#options.noWait) {
        const settled = await this.#client.waitForIdle();
        if (settled.status === 'error') {
          this.#writeError(settled.message ?? 'A subroutine run failed.');
          code = 1;
        }
      }
    } catch (error) {
      this.#writeError(error instanceof Error ? error.message : String(error));
      code = 1;
    } finally {
      this.#teardown();
    }

    return code;
  }

  /**
   * Detach on SIGINT.
   *
   * The daemon and its work keep running; this only ends the client.
   */
  interrupt(): void {
    this.#write('');
    this.#write('Detached. The daemon and its work keep running (`stop` halts subroutines).');
    this.#requestExit('interrupt');
  }

  // -- internals ------------------------------------------------------------

  async #run(line: string): Promise<CommandResult> {
    return this.#client.run(line, { onOutput: (output) => this.#write(output) });
  }

  #requestExit(reason: string): void {
    if (!this.#exitRequested) {
      this.#exitRequested = true;
      this.#options.client.close();
    }
    this.#rl?.close();
    this.#onExit?.(reason);
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#pending.length > 0 && !this.#exitRequested) {
        const next = this.#pending.shift();
        if (next === undefined) break;

        this.#closePrompt();
        let result: CommandResult;
        try {
          result = await this.#run(next);
        } catch (error) {
          this.#writeError(error instanceof Error ? error.message : String(error));
          this.#requestExit('connection lost');
          return;
        }

        if (result.status === 'error' && result.message !== undefined) {
          this.#writeError(result.message);
        }
        if (result.status === 'exit') {
          this.#write('Detached. The daemon keeps running.');
          this.#requestExit('exit command');
          return;
        }
        if (result.status === 'shutdown') {
          this.#write('The daemon is shutting down.');
          this.#requestExit('daemon shutdown');
          return;
        }
      }
      if (this.#exitRequested) this.#pending.length = 0;
    } finally {
      this.#busy = false;
      this.#prompt();
    }
  }

  #prompt(): void {
    if (this.#exitRequested || this.#closed || this.#busy) return;
    if (!isInteractive() || this.#promptVisible) return;
    this.#promptVisible = true;
    process.stdout.write(PROMPT);
  }

  #installObservers(): void {
    this.#unsubscribe = this.#client.onEvent((event) => {
      switch (event.kind) {
        case 'log':
          this.#render(() => this.#write(renderLogEvent(event.record)));
          return;
        case 'task':
          // Only subroutine runs are interesting to a client; per-keystroke
          // input tasks would be noise.
          if (event.task.kind === 'subroutine') {
            this.#render(() => this.#write(renderTaskEvent(event.task)));
          }
          return;
        case 'stopping':
          this.#render(() => this.#write(`The daemon is stopping (${event.reason}).`));
          return;
      }
    });
  }

  /** Draw around the prompt so async output does not land on the same line. */
  #render(draw: () => void): void {
    this.#closePrompt();
    draw();
    this.#prompt();
  }

  #closePrompt(): void {
    if (!this.#promptVisible) return;
    process.stdout.write('\n');
    this.#promptVisible = false;
  }

  #teardown(): void {
    this.#closePrompt();
    this.#unsubscribe?.();
    this.#rl?.close();
    this.#client.close();
  }
}
