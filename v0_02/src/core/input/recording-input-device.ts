/**
 * Dry-run input driver.
 *
 * Same {@link InputDevice} contract as the real driver, but nothing reaches the
 * operating system: every request is validated, recorded, and returned. This is
 * what makes the program safe to develop against — subroutines can be written,
 * run and cancelled without the agent grabbing the real keyboard mid-sentence.
 *
 * It also doubles as the mock for tests, since {@link RecordingInputDevice.actions}
 * is a readable transcript of everything that was requested.
 */

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
import { resolveChord } from './nut-input-device.js';

/** One recorded action, for inspection by tests and the `--trace` flag. */
export type RecordedAction =
  | { type: 'typeText'; text: string }
  | { type: 'pressKey'; chord: string[] }
  | { type: 'moveMouse'; to: Point }
  | { type: 'clickMouse'; button: string; times: number; at?: Point }
  | { type: 'scroll'; axis: 'vertical' | 'horizontal'; steps: number };

export interface RecordingInputDeviceOptions {
  /** Pretend the screen is this big; used to validate cursor targets. */
  screenSize?: { width: number; height: number };
  /** Time a simulated cursor move takes; set 0 to make dry runs instant. */
  moveDurationMs?: number;
  /** Report cursor reads as this position when no move has happened yet. */
  initialCursor?: Point;
  /** Injectable delay, for tests. */
  clock?: SleepClock;
}

export class RecordingInputDevice implements InputDevice {
  readonly name = 'recorder';

  readonly #actions: RecordedAction[] = [];
  readonly #screenSize: { width: number; height: number };
  readonly #moveDurationMs: number;
  readonly #clock: SleepClock;
  #cursor: Point;
  #open = false;

  constructor(options: RecordingInputDeviceOptions = {}) {
    this.#screenSize = options.screenSize ?? { width: 1_920, height: 1_080 };
    this.#moveDurationMs = options.moveDurationMs ?? 0;
    this.#cursor = options.initialCursor ?? { x: 0, y: 0 };
    this.#clock = options.clock ?? realSleep;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Everything requested so far, oldest first. */
  get actions(): readonly RecordedAction[] {
    return this.#actions;
  }

  /** Drop the transcript, e.g. between test cases. */
  clear(): void {
    this.#actions.length = 0;
  }

  async open(): Promise<void> {
    this.#open = true;
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  async typeText(request: TypeTextRequest, signal?: CancellationSignal): Promise<void> {
    this.#prepare(signal);
    for (const character of request.text) {
      signal?.throwIfCancelled();
      this.#actions.push({ type: 'typeText', text: character });
      await cancellableSleep(request.charDelayMs ?? TIMING.charDelay, this.#signal(signal), this.#clock);
    }
  }

  async pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void> {
    this.#prepare(signal);
    // Validate the key names exactly as the live driver would, so dry runs catch
    // a typo like `crtl` instead of hiding it.
    resolveChord(request.chord);
    this.#actions.push({ type: 'pressKey', chord: [...request.chord] });
    await cancellableSleep(request.keyDelayMs ?? TIMING.keyDelay, this.#signal(signal), this.#clock);
  }

  async getCursorPosition(): Promise<Point> {
    this.#prepare();
    return { ...this.#cursor };
  }

  async moveMouse(request: MoveMouseRequest, signal?: CancellationSignal): Promise<void> {
    this.#prepare(signal);
    const target = { x: Math.round(request.x), y: Math.round(request.y) };
    this.#assertOnScreen(target);
    this.#cursor = target;
    this.#actions.push({ type: 'moveMouse', to: target });
    const duration = request.durationMs ?? this.#moveDurationMs;
    if (duration > 0) {
      await cancellableSleep(duration, this.#signal(signal), this.#clock);
    }
  }

  async clickMouse(
    request: ClickMouseRequest = {},
    signal?: CancellationSignal,
  ): Promise<void> {
    this.#prepare(signal);
    const times = Math.max(1, Math.trunc(request.times ?? 1));
    if (request.at !== undefined) {
      await this.moveMouse({ ...request.at, durationMs: 0 }, signal);
    }
    this.#actions.push({
      type: 'clickMouse',
      button: request.button ?? 'left',
      times,
      ...(request.at !== undefined ? { at: { ...request.at } } : {}),
    });
  }

  async scroll(request: ScrollRequest, signal?: CancellationSignal): Promise<void> {
    this.#prepare(signal);
    this.#actions.push({
      type: 'scroll',
      axis: request.axis,
      steps: Math.trunc(request.steps),
    });
  }

  // -- internals ------------------------------------------------------------

  #prepare(signal?: CancellationSignal): void {
    if (!this.#open) {
      throw new Error('Dry-run device is not open. Call open() first.');
    }
    signal?.throwIfCancelled();
  }

  /** The recorder is interruptible, so it always has a signal to honour. */
  #signal(signal?: CancellationSignal): CancellationSignal {
    return signal ?? NEVER_CANCELLED;
  }

  #assertOnScreen(point: Point): void {
    const { width, height } = this.#screenSize;
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
      throw new Error(
        `Point (${point.x}, ${point.y}) is outside the simulated screen ${width}x${height}.`,
      );
    }
  }
}

const NEVER_CANCELLED: CancellationSignal = {
  isCancelled: false,
  throwIfCancelled: () => {},
  onCancel: () => {},
  offCancel: () => {},
};
