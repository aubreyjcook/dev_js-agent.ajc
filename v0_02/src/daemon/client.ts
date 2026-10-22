/**
 * The daemon, from a client's point of view.
 *
 * A `DaemonClient` is a small state machine around a socket:
 *
 *   connecting -> awaiting welcome -> sending hello -> ready -> closed
 *
 * Everything a caller does (`run`, `ping`, `waitForIdle`) is expressed as a
 * request with an id, and resolved when the matching reply arrives. Events
 * arrive unsolicited and are handed to subscribers.
 *
 * Two behaviours are deliberate and worth noticing:
 *
 * - **Handshake before use.** Commands cannot be sent until the daemon's
 *   `welcome` has been seen and the protocol versions agree. This turns "the
 *   daemon speaks a different dialect" into an immediate, clear error instead of
 *   a confusing failure halfway through a command.
 *
 * - **Every pending request is failed on disconnect.** A promise that never
 *   settles is the worst failure mode for a CLI: the user sees a hang. When the
 *   socket closes, all in-flight requests are rejected with the reason.
 */

import {
  type ClientMessage,
  type CommandResult,
  type DaemonInfo,
  type Endpoint,
  type MessageChannel,
  PROTOCOL_VERSION,
  type RuntimeEvent,
  type ServerMessage,
} from '../contract/index.js';
import { readRecord } from './discovery.js';
import { resolveEndpoint } from './endpoint.js';
import { connect as connectTransport } from './transport.js';

export interface DaemonClientOptions {
  stateDir: string;
  /** Override discovery (tests pass an explicit endpoint). */
  endpoint?: Endpoint;
  clientName?: string;
  /** Time allowed for connecting and completing the handshake. */
  timeoutMs?: number;
  /** Time allowed for a single command to be answered. */
  commandTimeoutMs?: number;
}

export interface CommandHandlers {
  /** Called for each line of output the command produces, as it arrives. */
  onOutput?: (line: string) => void;
}

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  onOutput?: (line: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DaemonClient {
  readonly #channel: MessageChannel<ServerMessage, ClientMessage>;
  readonly #commandTimeoutMs: number;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #pings = new Map<number, (error?: Error) => void>();
  readonly #eventHandlers = new Set<(event: RuntimeEvent) => void>();
  readonly #ready: Promise<DaemonInfo>;
  #info?: DaemonInfo;
  #nextId = 1;
  #problem?: string;

  /** Where this client should connect, honouring the discovery file. */
  static async resolveEndpoint(stateDir: string): Promise<Endpoint> {
    const record = await readRecord(stateDir);
    return record?.endpoint ?? resolveEndpoint({ stateDir });
  }

  /** Connect and complete the handshake. Throws on any failure. */
  static async connect(options: DaemonClientOptions): Promise<DaemonClient> {
    const endpoint = options.endpoint ?? (await DaemonClient.resolveEndpoint(options.stateDir));
    const timeoutMs = options.timeoutMs ?? 5_000;
    const channel = await connectTransport(endpoint, timeoutMs);
    const client = new DaemonClient(channel, { ...options, endpoint, timeoutMs });
    try {
      await client.#ready;
    } catch (error) {
      channel.close();
      throw error;
    }
    return client;
  }

  private constructor(
    channel: MessageChannel<ServerMessage, ClientMessage>,
    options: DaemonClientOptions,
  ) {
    this.#channel = channel;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;

    let resolveReady: (info: DaemonInfo) => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    this.#ready = new Promise<DaemonInfo>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const handshakeTimer = setTimeout(() => {
      rejectReady(new Error('The daemon did not send a welcome message in time.'));
      channel.close();
    }, options.timeoutMs ?? 5_000);
    handshakeTimer.unref?.();

    channel.onMessage((message) => {
      if (message.kind === 'welcome') {
        clearTimeout(handshakeTimer);
        if (message.protocol !== PROTOCOL_VERSION) {
          const problem =
            `Protocol mismatch: daemon speaks v${message.protocol}, ` +
            `this client speaks v${PROTOCOL_VERSION}. ` +
            'Stop the old daemon and start it with this version.';
          rejectReady(new Error(problem));
          channel.close();
          return;
        }
        this.#info = message.daemon;
        channel.send({
          kind: 'hello',
          protocol: PROTOCOL_VERSION,
          clientName: options.clientName ?? 'js-agent-client',
        });
        resolveReady(message.daemon);
        return;
      }
      this.#handle(message);
    });

    channel.onClose((reason) => {
      clearTimeout(handshakeTimer);
      const error = new Error(
        this.#problem ?? `The daemon closed the connection${reason !== undefined ? `: ${reason}` : '.'}`,
      );
      rejectReady(error);
      this.#failPending(error);
    });
  }

  /** Resolves once the handshake is complete. */
  get ready(): Promise<DaemonInfo> {
    return this.#ready;
  }

  get info(): DaemonInfo {
    if (this.#info === undefined) throw new Error('Client is not connected yet.');
    return this.#info;
  }

  get isOpen(): boolean {
    return this.#channel.isOpen;
  }

  /** Run one command and wait for its outcome. */
  async run(line: string, handlers: CommandHandlers = {}): Promise<CommandResult> {
    await this.#ready;
    // Ids rise monotonically rather than reusing small numbers. A late reply for
    // an abandoned request must not be mistaken for the answer to a new one.
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<CommandResult>((resolve, reject) => {
      // Every request has its own timeout, so a daemon that stops answering
      // fails the caller instead of leaving a CLI hanging forever.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`No reply from the daemon within ${this.#commandTimeoutMs} ms.`));
      }, this.#commandTimeoutMs);
      // `unref` so a pending request does not keep the process alive by itself;
      // the socket does that while it is genuinely connected.
      timer.unref?.();

      // The entry is registered *before* sending. A fast reply cannot arrive
      // before there is somewhere to put it.
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        ...(handlers.onOutput !== undefined ? { onOutput: handlers.onOutput } : {}),
      });
      this.#channel.send({ kind: 'command', id, line });
    });
  }

  /**
   * Ask the daemon to wait until nothing is running.
   *
   * This is what gives `--attach --exec` the same "settle between commands"
   * behaviour as a local `--exec` run: the *daemon* owns the work, so only the
   * daemon can say when it has finished.
   */
  async waitForIdle(): Promise<CommandResult> {
    await this.#ready;
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('The daemon did not confirm it was idle in time.'));
      }, this.#commandTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#channel.send({ kind: 'wait', id });
    });
  }

  async ping(): Promise<void> {
    await this.#ready;
    const id = this.#nextId;
    this.#nextId += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pings.delete(id);
        reject(new Error('No pong from the daemon.'));
      }, 4_000);
      timer.unref?.();
      this.#pings.set(id, (error) => {
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve();
      });
      this.#channel.send({ kind: 'ping', id });
    });
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.#eventHandlers.add(handler);
    return () => {
      this.#eventHandlers.delete(handler);
    };
  }

  close(): void {
    this.#channel.close();
  }

  // -- internals ------------------------------------------------------------

  #handle(message: ServerMessage): void {
    switch (message.kind) {
      case 'welcome':
        // Handled by the handshake closure.
        return;
      case 'output': {
        this.#pending.get(message.id)?.onOutput?.(message.line);
        return;
      }
      case 'result': {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve({
          status: message.status,
          ...(message.message !== undefined ? { message: message.message } : {}),
        });
        return;
      }
      case 'pong': {
        this.#pings.get(message.id)?.();
        this.#pings.delete(message.id);
        return;
      }
      case 'event': {
        for (const handler of [...this.#eventHandlers]) {
          try {
            handler(message.event);
          } catch {
            // A rendering subscriber must not break the client.
          }
        }
        return;
      }
      case 'problem': {
        this.#problem = message.message;
        this.#failPending(new Error(message.message));
        this.#channel.close();
        return;
      }
    }
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    for (const [id, settle] of this.#pings) {
      settle(error);
      this.#pings.delete(id);
    }
  }
}
