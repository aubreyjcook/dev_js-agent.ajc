/**
 * Events the runtime publishes about itself.
 *
 * This is the mechanism that lets several terminals show the same truth. In
 * v0_01 the terminal observed the task registry directly, in-process. Now the
 * observation is published on a bus, and the daemon forwards it to every
 * connected client — so a subroutine started in one terminal shows progress in
 * all of them.
 */

import type { LogLevel } from './logger.js';
import type { TaskSnapshot } from './tasks.js';

/**
 * A log record on the wire.
 *
 * `time` is an ISO-8601 string rather than a `Date` deliberately: `Date`
 * survives `JSON.stringify` as a string anyway, so this makes the wire format
 * honest instead of relying on a silent conversion.
 */
export interface LogEventRecord {
  level: LogLevel;
  source: string;
  message: string;
  time: string;
}

export type RuntimeEvent =
  /** Somebody logged something, in either half of the program. */
  | { kind: 'log'; record: LogEventRecord }
  /** A task changed state or progress detail. */
  | { kind: 'task'; task: TaskSnapshot }
  /** The host is going away; clients should expect their connection to close. */
  | { kind: 'stopping'; reason: string };

/** Convenience for renderers: the one-line form of a task event. */
export function isTerminalTaskEvent(task: TaskSnapshot): boolean {
  return task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled';
}
