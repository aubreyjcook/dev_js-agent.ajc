/** Logging vocabulary shared by the agent, the subroutines and the terminal. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** A single log record. `source` identifies the emitter, e.g. `agent` or `sub:type-text`. */
export interface LogRecord {
  level: LogLevel;
  source: string;
  message: string;
  time: Date;
}

/** Minimal structured logger. Implementations must never throw. */
export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
  /** Derive a logger that reports under `source`. */
  child(source: string): Logger;
}
