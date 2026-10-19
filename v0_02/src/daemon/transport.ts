/**
 * The transport: how a daemon listens and how a client connects.
 *
 * One implementation covers both endpoint kinds because Node's `net` module
 * already treats a named pipe (Windows) and a unix domain socket (POSIX) as a
 * "path to listen on". That uniformity is the reason `Endpoint` has only two
 * variants: `local` and `tcp`.
 *
 * The interesting parts are the failure paths, which are the difference between
 * a daemon you can run and one you cannot:
 *
 * - **A stale socket file.** If a daemon was killed, `daemon.sock` remains on
 *   POSIX and `listen` fails with `EADDRINUSE`. We probe it first: if nothing is
 *   answering, the file is debris and is removed.
 * - **Port collision.** TCP bind failures are reported as a clear message rather
 *   than an unhandled `error` event.
 * - **Ephemeral ports.** With `port: 0` the OS chooses. The resolved endpoint is
 *   returned *after* listening, so the discovery file records the real port.
 * - **Socket permissions.** On POSIX the socket is chmodded to 0600, so it is
 *   not automatically reachable by other users on the machine.
 */

import { access, chmod, unlink } from 'node:fs/promises';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';

import {
  type ClientMessage,
  type Endpoint,
  type MessageChannel,
  type ServerMessage,
  isClientMessage,
  isServerMessage,
} from '../contract/index.js';
import { JsonLineChannel } from './framing.js';

export interface ListeningServer {
  /** The endpoint actually bound — with the real port when one was requested. */
  readonly endpoint: Endpoint;
  readonly connectionCount: number;
  onConnection(
    handler: (channel: MessageChannel<ClientMessage, ServerMessage>) => void,
  ): void;
  close(): Promise<void>;
}

export interface ListenOptions {
  /** Reports errors that happen after the server is up (rare, but not ignorable). */
  onError?: (error: Error) => void;
}

/** Bind and start accepting connections. Rejects with a readable error. */
export async function listen(
  endpoint: Endpoint,
  options: ListenOptions = {},
): Promise<ListeningServer> {
  if (endpoint.kind === 'local') {
    await clearStaleSocket(endpoint.path);
  }

  const sockets = new Set<Socket>();
  const connectionHandlers: ((
    channel: MessageChannel<ClientMessage, ServerMessage>,
  ) => void)[] = [];

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    const channel = new JsonLineChannel<ClientMessage, ServerMessage>(socket, {
      decode: (value) => (isClientMessage(value) ? value : undefined),
    });
    connectionHandlers.forEach((handler) => handler(channel));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(explainListenError(endpoint, error));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    // Only the bind failure matters before `listening`; errors after that are
    // reported through `onError` rather than crashing the process.
    server.once('error', onError);
    server.once('listening', onListening);

    if (endpoint.kind === 'local') {
      server.listen(endpoint.path);
    } else {
      server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true });
    }
  });

  server.on('error', (error: Error) => options.onError?.(error));

  const bound = resolveBoundEndpoint(server, endpoint);
  if (bound.kind === 'local') {
    await restrictSocketPermissions(bound.path);
  }

  return {
    endpoint: bound,
    get connectionCount(): number {
      return sockets.size;
    },
    onConnection(handler) {
      connectionHandlers.push(handler);
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (bound.kind === 'local') await removeSocketFile(bound.path);
    },
  };
}

/**
 * Connect to a daemon, with a timeout.
 *
 * The timeout matters: connecting to a dead socket on some platforms can hang
 * for a long time, and a CLI that appears frozen is worse than one that says
 * "no daemon is listening".
 */
export async function connect(
  endpoint: Endpoint,
  timeoutMs = 4_000,
): Promise<MessageChannel<ServerMessage, ClientMessage>> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const socket = endpoint.kind === 'local'
      ? netConnect(endpoint.path)
      : netConnect({ host: endpoint.host, port: endpoint.port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${describe(endpoint)}.`));
    }, timeoutMs);
    timer.unref?.();

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `No daemon is listening at ${describe(endpoint)} (${error.message}). ` +
            'Start one with `--mode daemon`.',
        ),
      );
    });
  });

  return new JsonLineChannel<ServerMessage, ClientMessage>(socket, {
    decode: (value) => (isServerMessage(value) ? value : undefined),
  });
}

/** Human-readable endpoint, shared with logs and errors. */
export function describe(endpoint: Endpoint): string {
  return endpoint.kind === 'local'
    ? `pipe "${endpoint.path}"`
    : `tcp ${endpoint.host}:${endpoint.port}`;
}

/**
 * Is something actually accepting connections here?
 *
 * Used for readiness checks and for deciding whether a socket file is debris.
 * Deliberately does not speak the protocol: it must be cheap and must work
 * against an endpoint that is still starting up.
 */
export async function probeEndpoint(endpoint: Endpoint, timeoutMs = 1_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = endpoint.kind === 'local'
      ? netConnect(endpoint.path)
      : netConnect({ host: endpoint.host, port: endpoint.port });

    const settle = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

// -- internals --------------------------------------------------------------

function resolveBoundEndpoint(server: Server, requested: Endpoint): Endpoint {
  const address = server.address();
  if (requested.kind === 'local') return requested;
  if (address === null || typeof address === 'string') return requested;
  // Port 0 means "let the OS choose"; the caller must learn the real one.
  return { kind: 'tcp', host: requested.host, port: address.port };
}

/**
 * Remove a socket file that nobody is listening on.
 *
 * The probe is the whole point: if a daemon *is* listening, the file must be
 * left alone. Unlinking a live unix socket does not stop that daemon, but it
 * does make it unreachable for every future client — a nasty way to "clean up"
 * a working service.
 */
async function clearStaleSocket(path: string): Promise<void> {
  if (process.platform === 'win32') return; // named pipes are not files
  if (!(await pathExists(path))) return;
  if (await isListening(path)) {
    throw new Error(
      `A daemon is already listening at pipe "${path}". ` +
        'Use `--mode attach`, or `--stop-daemon` first.',
    );
  }
  try {
    await unlink(path);
  } catch {
    // Something else removed it between the probe and the unlink.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Can we actually connect to `path`? Used only to avoid deleting a live socket. */
async function isListening(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect(path);
    const settle = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function restrictSocketPermissions(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    // Owner-only, so another account on the machine cannot drive the agent.
    await chmod(path, 0o600);
  } catch {
    // Best effort: some filesystems do not support it.
  }
}

async function removeSocketFile(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

function explainListenError(endpoint: Endpoint, error: NodeJS.ErrnoException): Error {
  if (error.code === 'EADDRINUSE') {
    return new Error(
      `Something is already listening at ${describe(endpoint)}. ` +
        'A daemon may already be running — use `--mode attach`, or `--stop-daemon` first.',
    );
  }
  if (error.code === 'EACCES') {
    return new Error(
      `Permission denied binding ${describe(endpoint)}. ` +
        'On Windows this often means another user owns that pipe name.',
    );
  }
  return new Error(`Could not listen at ${describe(endpoint)}: ${error.message}`);
}
