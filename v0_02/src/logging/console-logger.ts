/**
 * Console logger.
 *
 * Lives in its own folder (not `core/`) because both halves of the program —
 * and the terminal — need to log, and neither half should own the other.
 */

import type { LogLevel, LogRecord, Logger } from '../contract/index.js';

export interface ConsoleLoggerOptions {
  /** Records below this level are dropped. */
  level?: LogLevel;
  /** Where records are written. Defaults to `process.stdout`. */
  sink?: (line: string) => void;
  /** When true, include an ISO timestamp on every line. */
  timestamps?: boolean;
  /** Prefix for every line, e.g. `js-agent`. */
  prefix?: string;
  /**
   * Observe every record that was actually emitted.
   *
   * Added in v0_02 so the daemon can forward log lines to attached clients. It
   * runs *in addition to* writing to the sink, so a daemon can log to its own
   * console/file while clients see the same records.
   */
  onRecord?: (record: LogRecord) => void;
}

interface SinkLoggerOptions {
  level: LogLevel;
  sink: (line: string) => void;
  timestamps: boolean;
  prefix: string;
  source: string;
  onRecord?: (record: LogRecord) => void;
}

/**
 * Straightforward `Logger` that writes one line per record.
 *
 * `onRecord` is how v0_02 turns logging into a broadcastable event without
 * teaching the logger about daemons or sockets: it reports, and someone else
 * decides who needs to hear it.
 */
export class ConsoleLogger implements Logger {
  readonly #options: SinkLoggerOptions;
  readonly #threshold: number;

  constructor(options: SinkLoggerOptions) {
    this.#options = options;
    this.#threshold = LEVEL_ORDER[options.level];
  }

  /** Build a top-level logger. */
  static create(options: ConsoleLoggerOptions = {}): ConsoleLogger {
    return new ConsoleLogger({
      level: options.level ?? 'info',
      sink: options.sink ?? ((line: string) => process.stdout.write(`${line}\n`)),
      timestamps: options.timestamps ?? false,
      prefix: options.prefix ?? '',
      source: options.prefix ?? 'app',
      ...(options.onRecord !== undefined ? { onRecord: options.onRecord } : {}),
    });
  }

  debug(message: string, ...meta: unknown[]): void {
    this.#emit('debug', message, meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.#emit('info', message, meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.#emit('warn', message, meta);
  }

  error(message: string, ...meta: unknown[]): void {
    this.#emit('error', message, meta);
  }

  child(source: string): Logger {
    const { prefix } = this.#options;
    return new ConsoleLogger({
      ...this.#options,
      source: prefix ? `${prefix}/${source}` : source,
    });
  }

  #emit(level: LogLevel, message: string, meta: unknown[]): void {
    if (LEVEL_ORDER[level] < this.#threshold) return;
    const detail = meta.length > 0 ? ` ${meta.map(formatMeta).join(' ')}` : '';
    const record: LogRecord = {
      level,
      source: this.#options.source,
      message: `${message}${detail}`,
      time: new Date(),
    };
    this.#options.onRecord?.(record);

    const parts: string[] = [];
    if (this.#options.timestamps) parts.push(record.time.toISOString());
    parts.push(`${level.toUpperCase().padEnd(5)}`);
    if (record.source) parts.push(`[${record.source}]`);
    parts.push(record.message);
    try {
      this.#options.sink(parts.join(' '));
    } catch {
      // A logger must never take the program down with it.
    }
  }
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function formatMeta(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
