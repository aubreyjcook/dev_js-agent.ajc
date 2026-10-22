/**
 * Live input driver: the only module in the program that touches the operating
 * system's keyboard and mouse.
 *
 * Everything above it (the agent, the subroutines, the terminal) is written
 * against `InputDevice`, so replacing nut-js means writing one new file in this
 * folder and changing nothing else.
 *
 * Rules enforced here, because this is the code with real-world effects:
 *   - the cancellation signal is checked before every single action, so the
 *     terminal's `stop` command is prompt even mid-sentence;
 *   - held modifiers are always released, so a failure cannot leave the user
 *     with a stuck Ctrl key;
 *   - typed text is restricted to printable ASCII, which is what a keycode
 *     driver can reproduce faithfully, and key names are validated before any
 *     key is pressed.
 */

import { Button, Key, keyboard, mouse, screen } from '@nut-tree-fork/nut-js';

import {
  type CancellationSignal,
  type ClickMouseRequest,
  type InputDevice,
  type MoveMouseRequest,
  type Point,
  type PressKeyRequest,
  type ScrollRequest,
  type SleepClock,
  TIMING,
  type TypeTextRequest,
  cancellableSleep,
  realSleep,
} from '../../contract/index.js';
import { type KeyToken, isModifier, normaliseKeyName, toDriverKey } from './keymap.js';
import { PRINTABLE_ASCII } from '../../shared/text.js';

/** Raised when a request cannot be carried out by this driver. */
export class InputUnavailableError extends Error {
  readonly kind = 'input-unavailable';
}

export interface NutInputDeviceOptions {
  /** Pause between typed characters, overriding {@link TIMING.charDelay}. */
  charDelayMs?: number;
  /** Pause after a key press, overriding {@link TIMING.keyDelay}. */
  keyDelayMs?: number;
  /** Pause between repeated clicks, overriding {@link TIMING.clickDelay}. */
  clickDelayMs?: number;
  /** Largest string a single `typeText` call may carry. */
  maxTextLength?: number;
  /** Injectable delay, for tests. */
  clock?: SleepClock;
}

const MAX_CHORD_KEYS = 6;

export class NutInputDevice implements InputDevice {
  readonly name = 'nut-js';

  readonly #options: Required<Omit<NutInputDeviceOptions, 'clock'>>;
  readonly #clock: SleepClock;
  #open = false;
  #screenSize?: { width: number; height: number };

  constructor(options: NutInputDeviceOptions = {}) {
    this.#options = {
      charDelayMs: options.charDelayMs ?? TIMING.charDelay,
      keyDelayMs: options.keyDelayMs ?? TIMING.keyDelay,
      clickDelayMs: options.clickDelayMs ?? TIMING.clickDelay,
      maxTextLength: options.maxTextLength ?? 4_096,
    };
    this.#clock = options.clock ?? realSleep;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Screen size, once the device has been opened. */
  get screenSize(): { width: number; height: number } | undefined {
    return this.#screenSize;
  }

  async open(): Promise<void> {
    if (this.#open) return;
    // Reading the screen size is what forces the native module to load, so a
    // missing prebuild surfaces here rather than on the first key press.
    const width = await screen.width();
    const height = await screen.height();
    this.#screenSize = { width, height };
    keyboard.config.autoDelayMs = 0;
    mouse.config.autoDelayMs = 0;
    mouse.config.mouseSpeed = 3_000;
    this.#open = true;
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  async typeText(request: TypeTextRequest, signal?: CancellationSignal): Promise<void> {
    this.#assertReady(signal);
    // Validate the whole string before the first keystroke: a refusal halfway
    // through a sentence is much worse than a refusal before it starts.
    this.#assertText(request.text);
    const charDelay = request.charDelayMs ?? this.#options.charDelayMs;
    for (const character of request.text) {
      // The signal is checked per character, which is the finest granularity
      // the agent can offer without interrupting a key mid-press.
      signal?.throwIfCancelled();
      await keyboard.type(character);
      await this.#pause(charDelay, signal);
    }
  }

  async pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void> {
    this.#assertReady(signal);
    const chord = resolveChord(request.chord);
    const keyDelay = request.keyDelayMs ?? this.#options.keyDelayMs;
    try {
      // nut-js expects modifiers first, in "natural" order.
      await keyboard.pressKey(...chord);
      await this.#pause(keyDelay, signal);
    } finally {
      // Always release, even if the press or the pause failed: a stuck modifier
      // is far worse than a failed keystroke. The spread makes a copy before
      // reversing, so the original chord order is untouched for the error path.
      try {
        await keyboard.releaseKey(...[...chord].reverse());
      } catch {
        // Nothing useful to do here; a pending error is more relevant.
      }
    }
    signal?.throwIfCancelled();
  }

  async getCursorPosition(): Promise<Point> {
    if (!this.#open) {
      throw new InputUnavailableError('Input device is not open.');
    }
    const position = await mouse.getPosition();
    return { x: position.x, y: position.y };
  }

  async moveMouse(request: MoveMouseRequest, signal?: CancellationSignal): Promise<void> {
    this.#assertReady(signal);
    const target: Point = { x: Math.round(request.x), y: Math.round(request.y) };
    this.#assertOnScreen(target);
    const duration = request.durationMs ?? TIMING.moveDuration;
    if (duration <= 0) {
      await mouse.setPosition(target);
      return;
    }

    // Hand the whole path to the driver rather than interpolating here: one
    // native call animates the travel, where stepping by hand would be
    // thousands of round trips. The requested duration is expressed as a speed,
    // which is the unit nut-js animates with.
    const origin = await this.getCursorPosition();
    const distance = Math.hypot(target.x - origin.x, target.y - origin.y);
    if (distance < 1) {
      await mouse.setPosition(target);
      return;
    }

    const speed = (distance / duration) * 1_000;
    mouse.config.mouseSpeed = speed;
    await mouse.move([target]);
    // The cursor may end a pixel or two away from the requested point; the
    // caller asked for a specific position, so land on it exactly.
    const landed = await this.getCursorPosition();
    if (landed.x !== target.x || landed.y !== target.y) {
      signal?.throwIfCancelled();
      await mouse.setPosition(target);
    }
  }

  async clickMouse(
    request: ClickMouseRequest = {},
    signal?: CancellationSignal,
  ): Promise<void> {
    this.#assertReady(signal);
    const times = Math.max(1, Math.trunc(request.times ?? 1));
    if (request.at !== undefined) {
      await this.moveMouse({ ...request.at, durationMs: request.durationMs ?? 0 }, signal);
    }
    const button = toDriverButton(request.button ?? 'left');
    for (let index = 0; index < times; index += 1) {
      // Between clicks, so a run of twenty is interruptible after any of them.
      signal?.throwIfCancelled();
      await mouse.click(button);
      // No trailing pause after the final click: the caller asked for `times`
      // clicks, not for a wait afterwards.
      if (index < times - 1) await this.#pause(this.#options.clickDelayMs, signal);
    }
  }

  async scroll(request: ScrollRequest, signal?: CancellationSignal): Promise<void> {
    this.#assertReady(signal);
    // Truncate rather than round: a partial wheel step is not a thing.
    const steps = Math.trunc(request.steps);
    if (steps === 0) return;
    // The contract uses a signed step count; the driver API wants a direction
    // and a magnitude, so the sign is decoded here and nowhere else.
    const amount = Math.abs(steps);
    if (request.axis === 'vertical') {
      await (steps > 0 ? mouse.scrollDown(amount) : mouse.scrollUp(amount));
    } else {
      await (steps > 0 ? mouse.scrollRight(amount) : mouse.scrollLeft(amount));
    }
    signal?.throwIfCancelled();
  }

  // -- internals ------------------------------------------------------------

  #assertReady(signal: CancellationSignal | undefined): void {
    if (!this.#open) {
      throw new InputUnavailableError(
        'Input device is not open. Call open() before sending input.',
      );
    }
    signal?.throwIfCancelled();
  }

  #assertText(text: string): void {
    // Three separate refusals, each with a different remedy for the caller:
    // supply something, split it up, or stop trying to send non-ASCII.
    if (text.length === 0) {
      throw new InputUnavailableError('Nothing to type: text was empty.');
    }
    if (text.length > this.#options.maxTextLength) {
      throw new InputUnavailableError(
        `Refusing to type ${text.length} characters in one step ` +
          `(limit ${this.#options.maxTextLength}). Split it into chunks.`,
      );
    }
    if (!PRINTABLE_ASCII.test(text)) {
      // Spread so the offending value is a whole code point; `charAt` would
      // split an emoji's surrogate pair and report half a character.
      const offending = [...text].find((character) => !/[\x20-\x7E]/.test(character));
      throw new InputUnavailableError(
        `Cannot type ${JSON.stringify(offending)}: this driver reproduces ` +
          'printable ASCII only. Strip or transliterate the text first.',
      );
    }
  }

  #assertOnScreen(point: Point): void {
    // Only possible once opened and the screen size is known; before that the
    // point is accepted and the driver's own clipping applies.
    const size = this.#screenSize;
    if (size === undefined) return;
    if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) {
      throw new InputUnavailableError(
        `Point (${point.x}, ${point.y}) is outside the screen ` +
          `${size.width}x${size.height}.`,
      );
    }
  }

  async #pause(ms: number, signal?: CancellationSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal === undefined) {
      await this.#clock(ms);
      return;
    }
    await cancellableSleep(ms, signal, this.#clock);
  }
}

/** Translate contract key names into nut-js keys, modifiers first. */
export function resolveChord(raw: readonly string[]): Key[] {
  if (raw.length === 0) {
    throw new InputUnavailableError('A key press needs at least one key.');
  }
  if (raw.length > MAX_CHORD_KEYS) {
    throw new InputUnavailableError(
      `Refusing a chord of ${raw.length} keys; ${MAX_CHORD_KEYS} is the ceiling.`,
    );
  }
  const tokens: KeyToken[] = raw.map((entry) => normaliseKeyName(entry));
  const modifiers = tokens.filter(isModifier);
  const others = tokens.filter((token) => !isModifier(token));
  // Pressing a lone modifier is legitimate (tapping shift, say).
  const ordered = [...modifiers, ...others];
  return ordered.map((token) => toDriverKey(token));
}

function toDriverButton(button: 'left' | 'middle' | 'right'): Button {
  switch (button) {
    case 'left':
      return Button.LEFT;
    case 'middle':
      return Button.MIDDLE;
    case 'right':
      return Button.RIGHT;
  }
}
