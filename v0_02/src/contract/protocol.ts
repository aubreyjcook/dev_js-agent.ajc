/**
 * The wire protocol between a daemon and an attached client.
 *
 * Rules that matter, and why:
 *
 * - **Versioned.** Both sides exchange `protocol` in the handshake and refuse to
 *   continue on a mismatch. Without this, an old client would send messages a
 *   new daemon interprets differently, and the failure would be baffling.
 *
 * - **Line-delimited JSON.** One JSON object per line. Trivial to debug (`nc`
 *   works), no length-prefix bookkeeping, and `JSON.stringify` escapes newlines
 *   so it cannot desynchronise on user text.
 *
 * - **Identified requests.** Each command carries an `id` so a client can match
 *   results to requests even if it has several in flight. Counting on ordering
 *   alone works today and breaks the first time something is added.
 *
 * - **Server speaks first.** The daemon sends `welcome` immediately, so a client
 *   learns the protocol version before it commits to anything.
 */

import type { CommandOutcome, DaemonSummary } from './commands.js';
import type { HostInfo } from './agent-api.js';
import type { RuntimeEvent } from './events.js';

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Everything a client needs to describe the daemon it is talking to. */
export interface DaemonInfo extends DaemonSummary {
  version: string;
  live: boolean;
  host: HostInfo;
  /** Textual form of the endpoint, for display. */
  endpointKind: 'local' | 'tcp';
}

/** Client -> daemon. */
export type ClientMessage =
  | { kind: 'hello'; protocol: number; clientName: string }
  | { kind: 'command'; id: number; line: string }
  /**
   * "Tell me when nothing is running."
   *
   * Exists because only the daemon owns the work: a script that sends a
   * subroutine and then asks for state needs a way to wait for the daemon's
   * queues to settle, and polling `list` would be both slower and racy.
   */
  | { kind: 'wait'; id: number }
  | { kind: 'ping'; id: number };

/** Daemon -> client. */
export type ServerMessage =
  | { kind: 'welcome'; protocol: number; daemon: DaemonInfo }
  /** One line of output produced by a running command. */
  | { kind: 'output'; id: number; line: string }
  /** The command finished. */
  | { kind: 'result'; id: number; status: CommandOutcome; message?: string }
  /** Something happened that every client should see. */
  | { kind: 'event'; event: RuntimeEvent }
  | { kind: 'pong'; id: number }
  /** A protocol-level problem; the daemon will close the connection. */
  | { kind: 'problem'; message: string };

/** Render an endpoint for humans. */
export function describeEndpoint(endpoint: {
  kind: 'local' | 'tcp';
  path?: string;
  host?: string;
  port?: number;
}): string {
  return endpoint.kind === 'tcp'
    ? `tcp ${endpoint.host ?? '127.0.0.1'}:${endpoint.port ?? 0}`
    : `pipe ${endpoint.path ?? '(none)'}`;
}

/**
 * Runtime validation of untrusted input.
 *
 * A type annotation is a claim about data that *this program* produced: it is
 * erased at runtime. Bytes arriving on a socket were produced by some other
 * process — possibly an older version, possibly something that is not this
 * program at all. Casting them to `ClientMessage` would be a lie, and the lie
 * would surface later as a confusing `undefined is not a function` deep inside
 * the daemon.
 *
 * So the boundary does what every boundary should do: parse, then narrow. These
 * guards are the only place the wire format is trusted, and they are checked
 * against `unknown`, never against a type we merely hope is right.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isClientMessage(value: unknown): value is ClientMessage {
  const record = asRecord(value);
  if (record === undefined) return false;
  switch (record['kind']) {
    case 'hello':
      return typeof record['protocol'] === 'number' && typeof record['clientName'] === 'string';
    case 'command':
      return typeof record['id'] === 'number' && typeof record['line'] === 'string';
    case 'wait':
      return typeof record['id'] === 'number';
    case 'ping':
      return typeof record['id'] === 'number';
    default:
      return false;
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  const record = asRecord(value);
  if (record === undefined) return false;
  switch (record['kind']) {
    case 'welcome':
      return typeof record['protocol'] === 'number' && asRecord(record['daemon']) !== undefined;
    case 'output':
      return typeof record['id'] === 'number' && typeof record['line'] === 'string';
    case 'result':
      return typeof record['id'] === 'number' && typeof record['status'] === 'string';
    case 'event':
      return asRecord(record['event']) !== undefined;
    case 'pong':
      return typeof record['id'] === 'number';
    case 'problem':
      return typeof record['message'] === 'string';
    default:
      return false;
  }
}
