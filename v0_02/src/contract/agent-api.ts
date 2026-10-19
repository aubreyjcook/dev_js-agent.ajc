/**
 * The agent surface that subroutines are allowed to use.
 *
 * A subroutine never touches the operating system, never imports the input
 * driver, and never manages its own cancellation. It describes input and the
 * agent performs it.
 */

import type {
  ClickMouseRequest,
  MoveMouseRequest,
  PressKeyRequest,
  ScrollRequest,
  TypeTextRequest,
} from './input.js';
import type { Logger } from './logger.js';
import type { Point } from './point.js';

export interface HostInfo {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  nodeVersion: string;
  /** Input driver in use, e.g. `nut-js` (live) or `recorder` (dry run). */
  driver: string;
  /** True when the driver actually drives the real keyboard/mouse. */
  live: boolean;
}

export interface AgentStatus {
  name: string;
  ready: boolean;
  host: HostInfo;
  /** Cursor position at the time of the call, when the device can report it. */
  cursor?: Point;
  /** Number of input tasks currently pending or running. */
  activeInputs: number;
  /** Total input tasks performed since start. */
  inputsPerformed: number;
}

/**
 * The agent reduced to "tell me what you are".
 *
 * The `status` command needs exactly this much and no more, so it depends on
 * this rather than on {@link AgentApi}. Keeping the read-only surface separate
 * is what stops a display-only module from being able to type on your keyboard.
 */
export interface AgentStatusSource {
  readonly name: string;
  readonly ready: boolean;
  status(): Promise<AgentStatus>;
}

/** The agent reduced to "where are you running". Used by the banner. */
export interface AgentHostSource {
  hostInfo(): HostInfo;
}

/**
 * The core agent's public API.
 *
 * Everything the subroutine layer can do to the machine goes through here.
 */
export interface AgentApi {
  /** Stable name for logs and banners. */
  readonly name: string;
  /** True once {@link start} has completed and the device is usable. */
  readonly ready: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  hostInfo(): HostInfo;
  status(): Promise<AgentStatus>;

  /** Type a string of printable characters. */
  typeText(request: TypeTextRequest): Promise<void>;
  /** Press a single key or hold a chord, e.g. `['ctrl', 'c']`. */
  pressKey(request: PressKeyRequest): Promise<void>;

  getCursorPosition(): Promise<Point>;
  /** Move the cursor, optionally pacing the travel. */
  moveMouse(request: MoveMouseRequest): Promise<void>;
  /** Click once at the cursor, or once per {@link ClickMouseRequest.times}. */
  clickMouse(request?: ClickMouseRequest): Promise<void>;
  /** Scroll the wheel by whole steps. */
  scroll(request: ScrollRequest): Promise<void>;

  /** Derive a logger that reports under `<agent>/<source>`. */
  childLogger(source: string): Logger;
}
