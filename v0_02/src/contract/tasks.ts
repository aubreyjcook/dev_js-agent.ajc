/**
 * Task bookkeeping.
 *
 * Every unit of work in the program — a single input the agent performs, or a
 * whole subroutine run — is tracked as a {@link TaskRecord}. That is what makes
 * the terminal's `list` and `stop` commands possible.
 */

export const TASK_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States in which a task still occupies the runtime. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['pending', 'running'];

export function isActiveState(state: TaskState): boolean {
  return state === 'pending' || state === 'running';
}

export function isTerminalState(state: TaskState): boolean {
  return !isActiveState(state);
}

/**
 * What kind of work a task represents.
 *
 * `subroutine` tasks are the ones a user issues from the terminal; `input`
 * tasks are the individual hardware actions the agent performs underneath them.
 */
export type TaskKind = 'subroutine' | 'input';

export interface TaskError {
  name: string;
  message: string;
}

/** Immutable snapshot of a task, safe to print or hand to callers. */
export interface TaskSnapshot {
  id: string;
  kind: TaskKind;
  /** Subroutine name, or the input action name, e.g. `type-text`. */
  name: string;
  state: TaskState;
  /** Short human-readable progress note, e.g. `"typed 12/40 chars"`. */
  detail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: TaskError;
}

/** Handle returned to whoever created a task. */
export interface TaskHandle {
  readonly id: string;
  readonly snapshot: TaskSnapshot;
  /** Abort the task's cancellation signal. Safe to call more than once. */
  cancel(reason?: string): void;
}
