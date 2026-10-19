/**
 * The result of executing one command line.
 *
 * This lives in the contract — not in the terminal — because two very different
 * front ends now produce it: a local prompt and a remote client talking over a
 * socket. If each had its own notion of "what happened", they would drift.
 */

export const COMMAND_OUTCOMES = ['ok', 'empty', 'exit', 'error', 'shutdown'] as const;

/**
 * - `ok`       the command ran.
 * - `empty`    the line was blank; nothing to do.
 * - `exit`     the user asked to leave *this session* (detach, if remote).
 * - `error`    the command was rejected or failed.
 * - `shutdown` the user asked to stop the whole program/daemon.
 */
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

export interface CommandResult {
  status: CommandOutcome;
  /** Human-readable reason, present when `status` is `error`. */
  message?: string;
}

/**
 * What a client can learn about a running daemon without asking it anything
 * else. Sent in the `welcome` message.
 */
export interface DaemonSummary {
  pid: number;
  /** Human-readable form of the endpoint, e.g. `pipe \\.\pipe\js-agent-1a2b`. */
  endpoint: string;
  /** Number of clients connected at the time the summary was produced. */
  clients: number;
  /** ISO-8601 timestamp. */
  startedAt: string;
}
