/**
 * Shared rendering.
 *
 * Both front ends must present the same event in the same way, or the daemon
 * would feel like a different program from the local prompt. Putting the
 * formatting here means "how does a task update look?" has one answer.
 *
 * Rendering is a pure string transformation on purpose: it is the easiest kind
 * of code to test, and it keeps I/O decisions (stdout, a socket) out of the
 * formatting logic.
 */

import {
  type LogEventRecord,
  type Subroutine,
  type TaskSnapshot,
} from '../contract/index.js';

/**
 * A task transition, as one line.
 *
 * Only subroutine tasks are rendered. Individual input actions are tracked for
 * `stop` and for counters, but printing every keypress would drown the output.
 */
export function renderTaskEvent(task: TaskSnapshot): string {
  const detail = task.detail !== undefined ? ` · ${task.detail}` : '';
  return `[${task.id}] ${task.name}: ${task.state}${detail}`;
}

/** A log record, in the same shape the console logger prints locally. */
export function renderLogEvent(record: LogEventRecord): string {
  const level = record.level.toUpperCase().padEnd(5);
  const source = record.source !== '' ? ` [${record.source}]` : '';
  return `${level}${source} ${record.message}`;
}

/** A row for the `list` command. */
export function formatTaskRow(task: TaskSnapshot): string {
  const detail = task.detail !== undefined ? ` · ${task.detail}` : '';
  const error = task.error !== undefined ? ` · ${task.error.message}` : '';
  const state = task.state === 'pending' || task.state === 'running'
    ? `${task.state} ${formatElapsed(task.startedAt ?? task.createdAt)}`
    : task.state;
  return `${task.id.padEnd(8)} ${task.name.padEnd(14)} ${state}${detail}${error}`;
}

/** Seconds since a timestamp, one decimal place. */
export function formatElapsed(since: number): string {
  const seconds = Math.max(0, (Date.now() - since) / 1_000);
  return `${seconds.toFixed(1)}s`;
}

/** `name <required> [optional]`, for `help`. */
export function formatUsage(subroutine: Subroutine): string {
  const params = (subroutine.params ?? []).map((param) => {
    const inner = param.rest === true ? `${param.name} ...` : param.name;
    return param.required ? `<${inner}>` : `[${inner}]`;
  });
  return [subroutine.name, ...params].join(' ');
}
