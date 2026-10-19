/**
 * Framing: turning a byte stream into discrete JSON messages.
 *
 * A TCP connection or pipe is a stream of bytes with no message boundaries. You
 * cannot assume one `data` event per message: a large message arrives in pieces,
 * and several small messages can arrive glued together. So a channel needs a
 * buffer and a rule for where a message ends.
 *
 * The rule here is newline-delimited JSON (NDJSON): one `JSON.stringify` object
 * per line. It is chosen over a length-prefixed binary format because it is
 * inspectable (you can `nc` a daemon and type a command), and because JSON
 * escapes newlines inside strings, so user text cannot break the framing.
 *
 * Two details that are easy to get wrong and are handled here:
 *
 * - **UTF-8 across chunk boundaries.** A multi-byte character can be split
 *   between two `data` events. `StringDecoder` holds the incomplete bytes until
 *   the rest arrives; `chunk.toString()` would corrupt it.
 * - **A size ceiling.** Without one, a peer that never sends a newline makes the
 *   daemon buffer until it dies. This is a remote denial-of-service in miniature,
 *   and the boundary should refuse it.
 */

import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';

import type { MessageChannel, PeerInfo } from '../contract/index.js';

/** Refuse anything larger than this on a single line. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface LineChannelOptions<Incoming> {
  /**
   * Parses one decoded line. Return `undefined` to reject it.
   *
   * The channel calls this rather than casting, so malformed input is rejected
   * at the edge instead of exploding somewhere unrelated.
   */
  decode: (value: unknown) => Incoming | undefined;
}

export class JsonLineChannel<Incoming, Outgoing>
  implements MessageChannel<Incoming, Outgoing>
{
  readonly peer: PeerInfo;
  readonly #socket: Socket;
  readonly #decode: (value: unknown) => Incoming | undefined;
  readonly #decoder = new StringDecoder('utf8');
  readonly #messageHandlers: ((message: Incoming) => void)[] = [];
  readonly #closeHandlers: ((reason?: string) => void)[] = [];
  #buffer = '';
  #open = true;

  constructor(socket: Socket, options: LineChannelOptions<Incoming>) {
    this.#socket = socket;
    this.#decode = options.decode;
    this.peer = {
      description: socket.remoteAddress
        ? `${socket.remoteAddress}:${socket.remotePort ?? 0}`
        : 'local',
    };

    // No `setEncoding` here: the decoder is fed raw buffers so it can hold an
    // incomplete multi-byte character until the next chunk completes it.
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error: Error) => this.#finish(error.message));
    socket.on('close', () => this.#finish('connection closed'));
    socket.on('end', () => this.#finish('connection ended'));
  }

  get isOpen(): boolean {
    return this.#open;
  }

  send(message: Outgoing): void {
    if (!this.#open) return;
    try {
      this.#socket.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#finish(error instanceof Error ? error.message : 'write failed');
    }
  }

  onMessage(handler: (message: Incoming) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    if (!this.#open) return;
    this.#finish('closed by local side');
    this.#socket.end();
    // A peer that will not hang up must not keep the process alive.
    setTimeout(() => this.#socket.destroy(), 1_000).unref?.();
  }

  // -- internals ------------------------------------------------------------

  #receive(chunk: Buffer): void {
    if (!this.#open) return;
    this.#buffer += this.#decoder.write(chunk);

    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
      if (line.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#finish('malformed JSON');
        return;
      }

      const message = this.#decode(parsed);
      if (message === undefined) {
        this.#finish('unrecognised message');
        return;
      }

      for (const handler of [...this.#messageHandlers]) {
        try {
          handler(message);
        } catch {
          // One bad handler must not poison the channel.
        }
      }
    }

    // Only the *incomplete* remainder is measured, so this bounds what a peer
    // that never sends a newline can make us hold.
    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_MESSAGE_BYTES) {
      this.#finish('message too large');
    }
  }

  #finish(reason: string): void {
    if (!this.#open) return;
    this.#open = false;
    this.#socket.destroy();
    for (const handler of [...this.#closeHandlers]) {
      try {
        handler(reason);
      } catch {
        // Ignored: teardown must run to completion.
      }
    }
  }
}
