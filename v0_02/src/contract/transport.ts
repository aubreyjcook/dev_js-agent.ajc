/**
 * Transport vocabulary: where a daemon listens, and what a connection is.
 *
 * The abstractions are deliberately narrow so that swapping the underlying
 * mechanism (named pipe, unix socket, loopback TCP, or an in-memory pipe in a
 * test) does not touch the daemon logic or the protocol.
 */

/**
 * Where a daemon can be reached.
 *
 * - `local` — a named pipe on Windows (`\\.\pipe\…`) or a unix domain socket on
 *   POSIX. Node's `net` module treats both the same way, which is why one kind
 *   covers them. This is the default: it is scoped to the filesystem, needs no
 *   port allocation, and inherits OS access control.
 * - `tcp` — loopback only. Useful where local sockets are restricted or when
 *   you want to watch the traffic, but it is reachable by any local process, so
 *   it is opt-in.
 */
export type Endpoint =
  | { kind: 'local'; path: string }
  | { kind: 'tcp'; host: string; port: number };

/** Who is on the other end, for logs. */
export interface PeerInfo {
  readonly description: string;
}

/**
 * A duplex channel of typed messages, with framing already handled.
 *
 * Generic in both directions on purpose: the server sends `ServerMessage` and
 * receives `ClientMessage`; a client is the other way round. Writing it once
 * generically means the framing and buffering logic is not duplicated.
 */
export interface MessageChannel<Incoming, Outgoing> {
  readonly peer: PeerInfo;
  readonly isOpen: boolean;
  send(message: Outgoing): void;
  /** Called once per complete message. */
  onMessage(handler: (message: Incoming) => void): void;
  /** Called once when the channel closes, with a reason when known. */
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

/** True when the endpoint is a filesystem-ish resource we may need to clean up. */
export function isLocalEndpoint(endpoint: Endpoint): endpoint is { kind: 'local'; path: string } {
  return endpoint.kind === 'local';
}
