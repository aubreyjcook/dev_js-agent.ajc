/**
 * Central registry of everything the program is doing.
 *
 * Both halves write here: the agent records each individual input, and the
 * subroutine layer records each run. That is deliberate — it is the single place
 * the terminal looks at, which is why `list` can show both, and why `stop` can
 * halt a subroutine *and* the input it is currently performing.
 *
 * The registry also owns each task's cancellation token, so nobody else has to
 * invent a way to interrupt work.
 */

import {
  ACTIVE_TASK_STATES,
  type CancellationController,
  CancelToken,
  type TaskError,
  type TaskHandle,
  type TaskKind,
  type TaskSnapshot,
  type TaskState,
  isActiveState,
  isTerminalState,
} from '../contract/index.js';

/** Called whenever a task changes state or detail. */
export type TaskObserver = (snapshot: TaskSnapshot) => void;

export interface TaskRegistryOptions {
  /**
   * How many finished tasks to remember for `list`. Active tasks are never
   * discarded, so this only bounds history.
   */
  historyLimit?: number;
}

interface TaskRecord {
  id: string;
  kind: TaskKind;
  name: string;
  state: TaskState;
  detail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: TaskError;
  readonly token: CancelToken;
}

export class TaskRegistry {
  readonly #records = new Map<string, TaskRecord>();
  readonly #controller: CancellationController;
  readonly #historyLimit: number;
  #counter = 0;
  #observer?: TaskObserver;
  readonly #idleWaiters = new Set<() => void>();

  constructor(options: TaskRegistryOptions = {}, controller: CancellationController = new CancelToken()) {
    this.#historyLimit = Math.max(1, options.historyLimit ?? 500);
    this.#controller = controller;
  }

  /** The registry-wide token, cancelled when the program shuts down. */
  get controller(): CancellationController {
    return this.#controller;
  }

  /** Watch every task transition; used by the terminal to react to completions. */
  observe(observer: TaskObserver | undefined): void {
    this.#observer = observer;
  }

  create(kind: TaskKind, name: string): TaskHandle {
    this.#prune();
    const id = `${kind === 'subroutine' ? 'sub' : 'in'}-${++this.#counter}`;
    const record: TaskRecord = {
      id,
      kind,
      name,
      state: 'pending',
      createdAt: Date.now(),
      token: new CancelToken(),
    };
    this.#records.set(id, record);
    this.#notify(record);
    return {
      id,
      get snapshot(): TaskSnapshot {
        return snapshotOf(record);
      },
      cancel: (reason?: string) => this.cancel(id, reason),
    };
  }

  /**
   * Record progress on a task. Only non-terminal tasks can be updated: a
   * finished task is final, so the stop/complete race always resolves to
   * whichever happened first.
   */
  update(
    id: string,
    patch: { state?: TaskState; detail?: string; error?: TaskError },
  ): TaskSnapshot | undefined {
    const record = this.#records.get(id);
    if (record === undefined) return undefined;
    if (isTerminalState(record.state)) return snapshotOf(record);

    if (patch.state !== undefined) {
      record.state = patch.state;
      if (patch.state === 'running' && record.startedAt === undefined) {
        record.startedAt = Date.now();
      }
      if (isTerminalState(patch.state)) {
        record.finishedAt = Date.now();
      }
    }
    if (patch.detail !== undefined) record.detail = patch.detail;
    if (patch.error !== undefined) record.error = patch.error;

    this.#notify(record);
    return snapshotOf(record);
  }

  /** Mark a task finished. Convenience over {@link update}. */
  finish(
    id: string,
    state: Extract<TaskState, 'completed' | 'failed' | 'cancelled'>,
    patch: { detail?: string; error?: TaskError } = {},
  ): TaskSnapshot | undefined {
    return this.update(id, { state, ...patch });
  }

  get(id: string): TaskSnapshot | undefined {
    const record = this.#records.get(id);
    return record === undefined ? undefined : snapshotOf(record);
  }

  /** All known tasks, oldest first. */
  list(filter: { kind?: TaskKind } = {}): TaskSnapshot[] {
    const records = [...this.#records.values()];
    return records
      .filter((record) => filter.kind === undefined || record.kind === filter.kind)
      .map(snapshotOf);
  }

  /** Tasks that are pending or running. */
  active(filter: { kind?: TaskKind } = {}): TaskSnapshot[] {
    return this.list(filter).filter((snapshot) => isActiveState(snapshot.state));
  }

  /** The cancellation signal for a task, for code that needs to observe it. */
  signalFor(id: string) {
    return this.#records.get(id)?.token.signal;
  }

  /** Ask one task to stop. Returns false when the task is unknown or finished. */
  cancel(id: string, reason?: string): boolean {
    const record = this.#records.get(id);
    if (record === undefined) return false;
    if (isTerminalState(record.state)) return false;
    record.token.cancel(reason ?? `Cancelled by request`);
    return true;
  }

  /** Ask every active task of a kind to stop. */
  cancelActive(kind: TaskKind | undefined, reason?: string): TaskSnapshot[] {
    const targets = this.active(kind === undefined ? {} : { kind });
    for (const target of targets) this.cancel(target.id, reason);
    return targets;
  }

  /**
   * Resolve once nothing of `kind` is active any more.
   *
   * Used by shutdown: it waits for in-flight input to finish rather than
   * guessing at a timeout.
   */
  whenIdle(kind?: TaskKind): Promise<void> {
    if (this.active(kind === undefined ? {} : { kind }).length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        if (this.active(kind === undefined ? {} : { kind }).length === 0) {
          this.#idleWaiters.delete(waiter);
          resolve();
        }
      };
      this.#idleWaiters.add(waiter);
    });
  }

  // -- internals ------------------------------------------------------------

  #notify(record: TaskRecord): void {
    const snapshot = snapshotOf(record);
    try {
      this.#observer?.(snapshot);
    } catch {
      // An observer must never break bookkeeping.
    }
    if (isTerminalState(snapshot.state)) {
      this.#notifyIdle();
    }
  }

  #notifyIdle(): void {
    if (this.#idleWaiters.size === 0) return;
    for (const waiter of [...this.#idleWaiters]) {
      try {
        waiter();
      } catch {
        this.#idleWaiters.delete(waiter);
      }
    }
  }

  /** Forget the oldest finished tasks once history grows past the limit. */
  #prune(): void {
    if (this.#records.size < this.#historyLimit) return;
    for (const [id, record] of this.#records) {
      if (isTerminalState(record.state)) {
        this.#records.delete(id);
        if (this.#records.size < this.#historyLimit) return;
      }
    }
  }
}

function snapshotOf(record: TaskRecord): TaskSnapshot {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.error !== undefined ? { error: { ...record.error } } : {}),
  };
}

/** Re-exported so consumers do not need to reach into `contract`. */
export { ACTIVE_TASK_STATES };
