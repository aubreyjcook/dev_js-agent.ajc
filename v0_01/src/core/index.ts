/**
 * Agent core barrel.
 *
 * `core/` owns the machine: the input driver, the agent that drives it, and the
 * task bookkeeping that makes work observable and cancellable. It has no notion
 * of subroutines or of the terminal.
 *
 * Anything outside this folder should import it from here (`from '../core'`)
 * rather than reaching into individual modules.
 */

export { Agent, linkSignals, toError, type AgentOptions } from './agent.js';
export { TaskRegistry, type TaskObserver, type TaskRegistryOptions } from './task-registry.js';
export {
  InputUnavailableError,
  NutInputDevice,
  resolveChord,
  type NutInputDeviceOptions,
} from './input/nut-input-device.js';
export {
  RecordingInputDevice,
  type RecordedAction,
  type RecordingInputDeviceOptions,
} from './input/recording-input-device.js';
export {
  ShiftedKeyError,
  UnknownKeyError,
  isModifier,
  normaliseKeyName,
  toDriverKey,
  type KeyToken,
} from './input/keymap.js';
