/**
 * The daemon: one process that owns the keyboard and mouse, serving many clients.
 *
 * What it is *not*: it does not run the commands. Deciding what a command means
 * lives in `CommandBroker`, exactly as it did in v0_01. The daemon is the part
 * that knows how clients arrive and leave.
 *
 * That separation is why v0_02 could add a second front end without touching the
 * agent or the subroutines. The daemon's job is small:
 *
 *   1. accept connections
 *   2. perform a version handshake with each one
 *   3. hand command lines to the broker and stream the results back
 *   4. broadcast runtime events (progress, logs) to everybody
 *   5. shut down cleanly, removing its discovery file
 *
 * The handshake is a real state machine, not ceremony: a connection that has not
 * said `hello` may not issue commands, and one that speaks the wrong protocol is
 * refused before it can do any damage.
 */

import {
  type ClientMessage,
  type CommandResult,
  type DaemonInfo,
  type DaemonSummary,
  type Endpoint,
  type HostInfo,
  type Logger,
  type MessageChannel,
  PROTOCOL_VERSION,
  type RuntimeEvent,
  type ServerMessage,
  describeEndpoint,
} from '../contract/index.js';
import { toError } from '../core/agent.js';
import type { EventBus } from '../shared/event-bus.js';
import type { CommandBroker } from '../terminal/broker.js';
import { clearRecord, ensureStateDir, findDaemon, writeRecord } from './discovery.js';
import { type DaemonLock, acquireDaemonLock } from './lock.js';
import { type ListeningServer, listen } from './transport.js';

export interface DaemonServerOptions {
  broker: CommandBroker;
  bus: EventBus<RuntimeEvent>;
  endpoint: Endpoint;
  stateDir: string;
  version: string;
  live: boolean;
  host: HostInfo;
  log: Logger;
  /**
   * A claim on the state directory, acquired before the runtime was built.
   *
   * Supplied by the caller so that "is another daemon running?" is answered
   * *before* the input device is opened. The server takes ownership and releases
   * it on shutdown.
   */
  lock?: DaemonLock;
  /** Cancel work and release the device. Called once, on shutdown. */
  shutdown: () => Promise<void>;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Time allowed for clients to flush their final messages before sockets close. */
const FLUSH_MS = 60;
/** Ceiling on graceful shutdown, after which we stop waiting and exit anyway. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

export class DaemonServer {
  readonly #options: DaemonServerOptions;
  readonly #clients = new Set<ClientSession>();
  #listener?: ListeningServer;
  #unsubscribe?: () => void;
  #stopPromise?: Promise<void>;
  #startedAt = new Date().toISOString();
  #boundEndpoint?: Endpoint;
  #lock?: DaemonLock;
  readonly #stopped: Promise<void>;
  #resolveStopped: () => void = () => {};

  constructor(options: DaemonServerOptions) {
    this.#options = options;
    // A promise rather than an event: the launcher awaits it, and it must
    // resolve whether the stop was requested by a signal or by a client.
    this.#stopped = new Promise<void>((resolve) => {
      this.#resolveStopped = resolve;
    });
  }

  /** Resolves once {@link stop} has completed. */
  get whenStopped(): Promise<void> {
    return this.#stopped;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get endpoint(): Endpoint {
    if (this.#boundEndpoint === undefined) {
      throw new Error('Daemon has not started yet.');
    }
    return this.#boundEndpoint;
  }

  /** Everything a client learns at handshake time. */
  info(): DaemonInfo {
    const endpoint = this.#boundEndpoint ?? this.#options.endpoint;
    return {
      ...this.summary(),
      version: this.#options.version,
      live: this.#options.live,
      host: this.#options.host,
      endpointKind: endpoint.kind,
    };
  }

  /** The volatile part, used by the `status` command. */
  summary(): DaemonSummary {
    return {
      pid: process.pid,
      endpoint: describeEndpoint(
        this.#boundEndpoint ?? this.#options.endpoint,
      ),
      clients: this.#clients.size,
      startedAt: this.#startedAt,
    };
  }

  /** Bind, publish the discovery file, and start serving. */
  async start(): Promise<DaemonInfo> {
    const { stateDir, endpoint, log } = this.#options;
    await ensureStateDir(stateDir);

    // Two layers, for two different failure modes. A reachable daemon means one
    // is already serving this state directory; the lock means a *starting*
    // daemon has claimed it, which is a race the record cannot see yet.
    const existing = await findDaemon(stateDir);
    if (existing !== null && existing.reachable) {
      throw new Error(
        `A daemon is already running for this state directory ` +
          `(pid ${existing.record.pid}). Attach with --mode attach, ` +
          'or stop it with --stop-daemon.',
      );
    }

    this.#lock = this.#options.lock ?? (await acquireDaemonLock(stateDir));

    try {
      const listener = await listen(endpoint, {
        onError: (error) => log.warn(`listener error: ${error.message}`),
      });
      this.#listener = listener;
      this.#boundEndpoint = listener.endpoint;
      this.#startedAt = new Date().toISOString();

      listener.onConnection((channel) => this.#accept(channel));

      this.#unsubscribe = this.#options.bus.subscribe((event) => this.#broadcast(event));

      // Publish only after listening: the file's existence means "ready to serve".
      await writeRecord(stateDir, {
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        endpoint: listener.endpoint,
        startedAt: this.#startedAt,
        version: this.#options.version,
        live: this.#options.live,
      });

      log.info(`daemon listening on ${describeEndpoint(listener.endpoint)} (pid ${process.pid})`);
      return this.info();
    } catch (error) {
      // Give the claim back, or the next attempt would be blocked by a daemon
      // that never started.
      await this.#lock.release();
      this.#lock = undefined;
      throw error;
    }
  }

  /**
   * Shut down. Idempotent: `shutdown` may be requested by a client, a signal,
   * and the launcher in quick succession.
   */
  stop(reason: string): Promise<void> {
    this.#stopPromise ??= this.#performStop(reason);
    return this.#stopPromise;
  }

  async #performStop(reason: string): Promise<void> {
    const { log, bus, stateDir, shutdown } = this.#options;
    log.info(`daemon stopping (${reason})`);

    try {
      // Let clients know before their sockets disappear, so an attached terminal
      // can print a sensible message instead of "connection lost".
      bus.publish({ kind: 'stopping', reason });
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      await delay(FLUSH_MS);

      await this.#listener?.close();
      await this.#withTimeout(shutdown());

      for (const client of [...this.#clients]) client.close('daemon stopping');
      this.#clients.clear();
      await clearRecord(stateDir);
      await this.#lock?.release();
      this.#lock = undefined;

      log.info('daemon stopped');
    } finally {
      this.#resolveStopped();
    }
  }

  async #withTimeout(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
      if (outcome === 'timeout') {
        this.#options.log.warn('shutdown is taking too long; continuing anyway');
      }
    } catch (error) {
      this.#options.log.error(`shutdown error: ${toError(error).message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #accept(channel: MessageChannel<ClientMessage, ServerMessage>): void {
    const session = new ClientSession({
      channel,
      log: this.#options.log.child('daemon'),
      broker: this.#options.broker,
      daemonInfo: () => this.info(),
      requestStop: (reason) => this.stop(reason),
      onGone: (gone) => {
        this.#clients.delete(gone);
        this.#options.log.debug(`client disconnected (${this.#clients.size} remaining)`);
      },
    });
    this.#clients.add(session);
    session.begin();
  }

  #broadcast(event: RuntimeEvent): void {
    for (const client of this.#clients) client.sendEvent(event);
  }
}

interface ClientSessionOptions {
  channel: MessageChannel<ClientMessage, ServerMessage>;
  log: Logger;
  broker: CommandBroker;
  daemonInfo: () => DaemonInfo;
  requestStop: (reason: string) => Promise<void>;
  onGone: (session: ClientSession) => void;
}

/**
 * One connected client.
 *
 * The per-connection state — has it said hello, what is it called — lives here
 * rather than in the server, because it is exactly that: per connection.
 */
class ClientSession {
  readonly #options: ClientSessionOptions;
  readonly #channel: MessageChannel<ClientMessage, ServerMessage>;
  #ready = false;
  #closed = false;
  #name = 'client';
  #handshakeTimer?: ReturnType<typeof setTimeout>;
  /**
   * Start of the window in which failures are reported back to this client.
   *
   * Reset after each `wait`, so a failure is reported once to the client that
   * asked, rather than repeatedly or to clients that arrived later.
   */
  #failureSince = Date.now();

  constructor(options: ClientSessionOptions) {
    this.#options = options;
    this.#channel = options.channel;
  }

  begin(): void {
    this.#channel.onMessage((message) => {
      // Handlers are synchronous; async work is dispatched and not awaited here
      // so a slow command cannot block the socket's own event loop.
      void this.#handle(message);
    });
    this.#channel.onClose(() => this.#finish());

    this.#send({
      kind: 'welcome',
      protocol: PROTOCOL_VERSION,
      daemon: this.#options.daemonInfo(),
    });

    this.#handshakeTimer = setTimeout(() => {
      this.#sendProblem('No handshake within 5 seconds; closing.');
    }, HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref?.();
  }

  sendEvent(event: RuntimeEvent): void {
    if (!this.#ready) return;
    this.#send({ kind: 'event', event });
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#send({ kind: 'problem', message: reason });
    this.#channel.close();
  }

  async #handle(message: ClientMessage): Promise<void> {
    if (this.#closed) return;

    // `ping` is answered before the handshake so readiness probes work.
    if (message.kind === 'ping') {
      this.#send({ kind: 'pong', id: message.id });
      return;
    }

    if (message.kind === 'hello') {
      if (this.#ready) {
        this.#sendProblem('Already greeted on this connection.');
        return;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        this.#sendProblem(
          `Protocol mismatch: this daemon speaks v${PROTOCOL_VERSION}, ` +
            `the client speaks v${message.protocol}.`,
        );
        return;
      }
      this.#ready = true;
      this.#name = message.clientName;
      this.#failureSince = Date.now();
      if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
      this.#options.log.debug(`client attached: ${this.#name}`);
      return;
    }

    if (!this.#ready) {
      this.#sendProblem('Expected a hello message before anything else.');
      return;
    }

    if (message.kind === 'wait') {
      const report = await this.#options.broker.drainReport(this.#failureSince);
      this.#failureSince = Date.now();
      this.#send({
        kind: 'result',
        id: message.id,
        status: report.result.status,
        ...(report.result.message !== undefined ? { message: report.result.message } : {}),
      });
      return;
    }

    // `message` is now narrowed to the command variant.
    await this.#runCommand(message.id, message.line);
  }

  async #runCommand(id: number, line: string): Promise<void> {
    const sink = (output: string): void => {
      this.#send({ kind: 'output', id, line: output });
    };

    let result: CommandResult;
    try {
      result = await this.#options.broker.execute(line, sink);
    } catch (error) {
      result = { status: 'error', message: toError(error).message };
    }

    this.#send({
      kind: 'result',
      id,
      status: result.status,
      ...(result.message !== undefined ? { message: result.message } : {}),
    });

    if (result.status === 'shutdown') {
      // The reply goes out first; the daemon then stops, which closes the socket.
      await this.#options.requestStop(`shutdown requested by ${this.#name}`);
    }
  }

  #send(message: ServerMessage): void {
    if (this.#closed) return;
    this.#channel.send(message);
  }

  #sendProblem(message: string): void {
    this.#send({ kind: 'problem', message });
    this.#channel.close();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#options.onGone(this);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
