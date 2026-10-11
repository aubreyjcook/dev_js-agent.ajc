/**
 * Request shapes for the input surface.
 *
 * The agent validates and executes these; subroutines only describe them.
 */

import type { MouseButton, Point } from './point.js';
import type { CancellationSignal } from './signals.js';

/** Human-paced defaults, in milliseconds. */
export const TIMING = {
  /** Pause after each typed character. */
  charDelay: 28,
  /** Pause after each key press or chord. */
  keyDelay: 40,
  /** Pause after a mouse click. */
  clickDelay: 60,
  /** Pause before starting any input, letting the user look away. */
  settle: 350,
  /** Duration of a synthetic mouse move when none is given. */
  moveDuration: 260,
} as const;

/** Typed text, one character at a time. */
export interface TypeTextRequest {
  text: string;
  /** Pause between characters, in ms. Defaults to {@link TIMING.charDelay}. */
  charDelayMs?: number;
}

/** A single key press, or a chord held together. */
export interface PressKeyRequest {
  /** e.g. `['ctrl', 'c']`, `['enter']`, `['f5']`. */
  chord: string[];
  /** Pause after the press, in ms. Defaults to {@link TIMING.keyDelay}. */
  keyDelayMs?: number;
}

/** Move the cursor to a point, optionally pacing the travel. */
export interface MoveMouseRequest extends Point {
  /** Travel time in ms; `0` teleports. Defaults to {@link TIMING.moveDuration}. */
  durationMs?: number;
}

/** Click at the current cursor position, or move to a point first. */
export interface ClickMouseRequest {
  button?: MouseButton;
  times?: number;
  /** When set, the cursor is moved here before clicking. */
  at?: Point;
  durationMs?: number;
}

/** Scroll by whole steps; signs are handled by the caller. */
export interface ScrollRequest {
  axis: 'vertical' | 'horizontal';
  /** Positive scrolls down/right, negative scrolls up/left. */
  steps: number;
}

/**
 * The hardware surface the agent exposes.
 *
 * This is the only thing that touches the operating system's input layer, so a
 * second implementation (dry-run recorder, remote transport, replay harness)
 * can be dropped in behind the same interface without subroutines noticing.
 *
 * Every method takes the caller's cancellation signal. Implementations must
 * check it *between individual actions*, not just at entry — that is what makes
 * `stop` feel immediate while a long string is being typed.
 */
export interface InputDevice {
  /** Human-readable driver name for banners and logs. */
  readonly name: string;
  /** True while the device is usable. */
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;

  /** Type a string of printable characters. */
  typeText(request: TypeTextRequest, signal?: CancellationSignal): Promise<void>;
  /** Press and release a chord of keys. */
  pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void>;

  /** Current cursor position. */
  getCursorPosition(): Promise<Point>;
  /** Move the cursor, optionally pacing the travel. */
  moveMouse(request: MoveMouseRequest, signal?: CancellationSignal): Promise<void>;
  /** Click a mouse button (at the current position unless `at` is given). */
  clickMouse(request?: ClickMouseRequest, signal?: CancellationSignal): Promise<void>;
  /** Scroll the wheel. */
  scroll(request: ScrollRequest, signal?: CancellationSignal): Promise<void>;
}
