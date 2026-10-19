/** Screen coordinates, in virtual-screen pixels (origin: top-left). */
export interface Point {
  x: number;
  y: number;
}

/** Logical mouse buttons. */
export type MouseButton = 'left' | 'middle' | 'right';

/**
 * Named keys, in layout-independent terms.
 *
 * A single printable character (`"a"`, `"7"`, `"!"`) is also accepted anywhere
 * a key name is, so callers rarely need this union directly.
 */
export type NamedKey =
  // modifiers
  | 'ctrl'
  | 'control'
  | 'shift'
  | 'alt'
  | 'meta'
  | 'super'
  | 'cmd'
  // editing / whitespace
  | 'enter'
  | 'return'
  | 'tab'
  | 'space'
  | 'backspace'
  | 'delete'
  | 'insert'
  | 'escape'
  | 'esc'
  | 'capslock'
  | 'print'
  | 'scrolllock'
  | 'pause'
  // navigation
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  // function row
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'
  // symbols, by name
  | 'minus'
  | 'equal'
  | 'leftbracket'
  | 'rightbracket'
  | 'backslash'
  | 'semicolon'
  | 'quote'
  | 'comma'
  | 'period'
  | 'slash'
  | 'grave'
  // numeric keypad
  | 'numpad0'
  | 'numpad1'
  | 'numpad2'
  | 'numpad3'
  | 'numpad4'
  | 'numpad5'
  | 'numpad6'
  | 'numpad7'
  | 'numpad8'
  | 'numpad9'
  | 'numpadadd'
  | 'numpadsubtract'
  | 'numpadmultiply'
  | 'numpaddivide'
  | 'numpaddecimal'
  | 'numpadenter';

/**
 * A chord of keys to hold simultaneously, e.g. `{ chord: ['ctrl', 'c'] }` or
 * `{ chord: ['ctrl', 'shift', 'escape'] }`.
 *
 * A single entry is a plain key press. Held modifiers are always released.
 */
export interface KeyChord {
  chord: string[];
}
