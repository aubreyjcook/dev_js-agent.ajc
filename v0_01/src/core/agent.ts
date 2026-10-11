/**
 * The agent core.
 *
 * Responsibility: turn *requests* into keyboard and mouse input, and keep a
 * record of every input it performs. Nothing here knows what a subroutine is —
 * it will happily type a keystroke whether the terminal asked for it directly or
 * a subroutine did. That ignorance is what keeps the two halves independent.
 *
 * What this file deliberately does *not* do:
 *   - it never reads from or writes to the terminal;
 *   - it never decides policy (what to type, how fast) beyond driver defaults;
 *   - it never calls `process.exit`.
 */

import { hostname, type } from 'node:os';

import {
  type AgentApi,
  type AgentStatus,
  type CancellationSignal,
  type ClickMouseRequest,
  type HostInfo,
  type InputDevice,
  type Logger,
  type MoveMouseRequest,
  type Point,
  type PressKeyRequest,
  type ScrollRequest,
  type TaskHandle,
  type TypeTextRequest,
  OperationCancelledError,
} from '../contract/index.js';
import type { TaskRegistry } from './task-registry.js';

export interface AgentOptions {
  /** Where input is actually sent. Swapped out for dry runs and tests. */
  device: InputDevice;
  /** Shared bookkeeping; the same registry the subroutine layer uses. */
  tasks: TaskRegistry;
  /** Parent logger; the agent reports under `<parent>/agent`. */
  logger: Logger;
  /** Name used in logs and the status banner. */
  name?: string;
}

export class Agent implements AgentApi {
  readonly name: string;

  readonly #device: InputDevice;
  readonly #tasks: TaskRegistry;
  readonly #log: Logger;
  #ready = false;
  #inputsPerformed = 0;
  #starting?: Promise<void>;

  constructor(options: AgentOptions) {
    this.#device = options.device;
    this.#tasks = options.tasks;
    this.#log = options.logger.child('agent');
    this.name = options.name ?? 'js-agent';
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** The driver in use. Exposed for the status banner. */
  get device(): InputDevice {
    return this.#device;
  }

  async start(): Promise<void> {
    if (this.#ready) return;
    // Guard against two `start` calls racing on the same device.
    this.#starting ??= this.#openDevice();
    await this.#starting;
  }

  async #openDevice(): Promise<void> {
    this.#log.debug(`opening input driver "${this.#device.name}"`);
    await this.#device.open();
    this.#ready = true;
    this.#log.info(
      `input ready (driver: ${this.#device.name}, ${this.#live ? 'live' : 'dry run'})`,
    );
  }

  /**
   * Shut the agent down.
   *
   * In-flight input is given a brief chance to finish rather than being cut off
   * mid-action, so the program never stops between a key going down and coming
   * up. If something is genuinely stuck, the task registry's own timeout in the
   * terminal is what moves things along.
   */
  async stop(): Promise<void> {
    this.#ready = false;
    await this.#tasks.whenIdle('input');
    await this.#device.close();
    this.#log.debug('input driver closed');
  }

  get #live(): boolean {
    return this.#device.name !== 'recorder';
  }

  hostInfo(): HostInfo {
    return {
      hostname: hostname(),
      platform: process.platform,
      release: typeof type === 'function' ? type() : process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node ?? 'unknown',
      driver: this.#device.name,
      live: this.#live,
    };
  }

  async status(): Promise<AgentStatus> {
    const host = this.hostInfo();
    const base: AgentStatus = {
      name: this.name,
      ready: this.#ready,
      host,
      activeInputs: this.#tasks.active({ kind: 'input' }).length,
      inputsPerformed: this.#inputsPerformed,
    };
    if (!this.#device.isOpen) return base;
    try {
      base.cursor = await this.#device.getCursorPosition();
    } catch {
      // A driver that cannot report the cursor is not a failure.
    }
    return base;
  }

  // -- input surface --------------------------------------------------------

  async typeText(request: TypeTextRequest): Promise<void> {
    await this.#performInput(
      'type-text',
      `typing ${request.text.length} char(s)`,
      async (signal) => {
        await this.#device.typeText(request, signal);
        return `${request.text.length} char(s)`;
      },
    );
  }

  async pressKey(request: PressKeyRequest): Promise<void> {
    const label = request.chord.join('+');
    await this.#performInput('press-key', `pressing ${label}`, async (signal) => {
      await this.#device.pressKey(request, signal);
      return label;
    });
  }

  async getCursorPosition(): Promise<Point> {
    return this.#device.getCursorPosition();
  }

  async moveMouse(request: MoveMouseRequest): Promise<void> {
    const { x, y } = request;
    await this.#performInput('move-mouse', `moving cursor to ${x},${y}`, async (signal) => {
      await this.#device.moveMouse(request, signal);
      return `cursor at ${x},${y}`;
    });
  }

  async clickMouse(request: ClickMouseRequest = {}): Promise<void> {
    const button = request.button ?? 'left';
    const times = Math.max(1, Math.trunc(request.times ?? 1));
    const where = request.at === undefined ? 'cursor' : `${request.at.x},${request.at.y}`;
    await this.#performInput(
      'click-mouse',
      `${times}x ${button} click at ${where}`,
      async (signal) => {
        await this.#device.clickMouse(request, signal);
        return `${times}x ${button} click at ${where}`;
      },
    );
  }

  async scroll(request: ScrollRequest): Promise<void> {
    const direction = request.steps >= 0 ? 'down' : 'up';
    await this.#performInput(
      'scroll',
      `scroll ${direction} ${Math.abs(request.steps)}`,
      async (signal) => {
        await this.#device.scroll(request, signal);
        return `${request.steps} step(s)`;
      },
    );
  }

  childLogger(source: string): Logger {
    return this.#log.child(source);
  }

  // -- input pipeline -------------------------------------------------------

  /**
   * Run one hardware action as a tracked task.
   *
   * Both cancellation routes are honoured: cancelling the task itself (via the
   * registry's `stop`) and cancelling the whole program (the registry's token).
   * Either one raises {@link OperationCancelledError} from inside `action`, which
   * is translated into a `cancelled` task record rather than a hard failure.
   */
  async #performInput(
    action: string,
    detail: string,
    run: (signal: CancellationSignal) => Promise<string>,
  ): Promise<void> {
    if (!this.#ready) {
      throw new Error(`Agent is not started; cannot ${action}. Call start() first.`);
    }

    const task = this.#tasks.create('input', action);
    const taskSignal = this.#tasks.signalFor(task.id);
    // `dispose` matters: the program-wide token lives as long as the process, so
    // every input that registers on it must unregister when it finishes.
    const { signal, dispose } = linkSignals(taskSignal, this.#tasks.controller.signal);
    this.#tasks.update(task.id, { state: 'running', detail });

    try {
      const completed = await run(signal);
      this.#inputsPerformed += 1;
      this.#tasks.finish(task.id, 'completed', { detail: completed });
    } catch (error) {
      const failure = toError(error);
      if (signal.isCancelled || failure instanceof OperationCancelledError) {
        this.#tasks.finish(task.id, 'cancelled', { detail: 'stopped' });
      } else {
        this.#tasks.finish(task.id, 'failed', {
          error: { name: failure.name, message: failure.message },
        });
      }
      throw failure;
    } finally {
      dispose();
    }
  }
}

/**
 * One signal that trips when any of its sources does.
 *
 * Keeps the "cancel this task" and "cancel everything" cases from leaking into
 * every driver implementation. `dispose` unregisters the underlying listeners,
 * which is what stops a long-lived program-wide token from accumulating one
 * listener per keystroke.
 */
export function linkSignals(
  ...signals: (CancellationSignal | undefined)[]
): { signal: CancellationSignal; dispose: () => void } {
  const sources = signals.filter(
    (signal): signal is CancellationSignal => signal !== undefined,
  );
  if (sources.length === 1) {
    return { signal: sources[0] as CancellationSignal, dispose: () => {} };
  }

  const listeners = new Set<() => void>();
  // Every (source, wrapper) pair we registered, so `dispose` can undo exactly
  // those and nothing else.
  const registrations: { source: CancellationSignal; wrapper: () => void }[] = [];
  const isCancelled = (): boolean => sources.some((signal) => signal.isCancelled);

  const signal: CancellationSignal = {
    get isCancelled() {
      return isCancelled();
    },
    throwIfCancelled: () => {
      if (isCancelled()) throw new OperationCancelledError('Cancelled');
    },
    onCancel: (listener: () => void) => {
      if (isCancelled()) {
        listener();
        return;
      }
      listeners.add(listener);
      for (const source of sources) {
        const wrapper = (): void => {
          // Deleting first makes the wrapper idempotent: several sources may
          // trip at once, and the listener must only run once.
          if (!listeners.delete(listener)) return;
          listener();
        };
        registrations.push({ source, wrapper });
        source.onCancel(wrapper);
      }
    },
    offCancel: (listener: () => void) => {
      listeners.delete(listener);
    },
  };

  return {
    signal,
    dispose: () => {
      listeners.clear();
      for (const { source, wrapper } of registrations) {
        source.offCancel(wrapper);
      }
      registrations.length = 0;
    },
  };
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error(`Non-error thrown: ${JSON.stringify(value)}`);
}

/** Exported for the terminal, which reports task handles it creates itself. */
export type { TaskHandle };
