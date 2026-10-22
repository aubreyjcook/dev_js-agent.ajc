/**
 * Keyboard vocabulary.
 *
 * Turns the contract's free-form key names (`"ctrl"`, `"f5"`, `"a"`, `"!"`)
 * into driver-neutral tokens, and from there into nut-js `Key` values. Keeping
 * this separate from the driver means a different backend only needs a new
 * `toDriverKey` table, not a new name-to-key mapping.
 */

import { Key } from '@nut-tree-fork/nut-js';

/** Driver-neutral key token: a lowercase name, or a single character. */
export type KeyToken = string;

/**
 * Aliases accepted on input, normalised to a canonical token.
 *
 * The canonical side is the vocabulary the rest of the program speaks; this
 * table exists so people can write what their keyboard or operating system
 * actually calls a key. `win`, `cmd`, `meta` and `super` are the same physical
 * key under different platform names, and `return`/`enter`, `esc`/`escape` are
 * the same key under two names. Normalising once here means no other module has
 * to care which word the user chose.
 */
const ALIASES: Record<string, KeyToken> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
  cmd: 'super',
  command: 'super',
  return: 'enter',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  space: 'space',
  spacebar: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  tab: 'tab',
  capslock: 'capslock',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown',
  print: 'print',
  printscreen: 'print',
  scrolllock: 'scrolllock',
  pause: 'pause',
  minus: 'minus',
  equal: 'equal',
  leftbracket: 'leftbracket',
  rightbracket: 'rightbracket',
  backslash: 'backslash',
  semicolon: 'semicolon',
  quote: 'quote',
  comma: 'comma',
  period: 'period',
  slash: 'slash',
  grave: 'grave',
  backtick: 'grave',
};

/**
 * Canonical name -> nut-js key, for everything that is not a single character.
 *
 * Modifiers deliberately map to their **left** variants: pressing `ctrl` should
 * behave like the left Ctrl key, which is what a person means, and chords are
 * pressed modifier-first by the driver. Single letters, digits and shifted
 * punctuation are handled separately in `toDriverKey`, because they need either
 * enum-name lookup or a shift.
 */
const NAMED_KEYS: Record<string, Key> = {
  ctrl: Key.LeftControl,
  shift: Key.LeftShift,
  alt: Key.LeftAlt,
  super: Key.LeftSuper,

  enter: Key.Enter,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  insert: Key.Insert,
  escape: Key.Escape,
  capslock: Key.CapsLock,
  print: Key.Print,
  scrolllock: Key.ScrollLock,
  pause: Key.Pause,

  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,

  f1: Key.F1,
  f2: Key.F2,
  f3: Key.F3,
  f4: Key.F4,
  f5: Key.F5,
  f6: Key.F6,
  f7: Key.F7,
  f8: Key.F8,
  f9: Key.F9,
  f10: Key.F10,
  f11: Key.F11,
  f12: Key.F12,

  minus: Key.Minus,
  equal: Key.Equal,
  leftbracket: Key.LeftBracket,
  rightbracket: Key.RightBracket,
  backslash: Key.Backslash,
  semicolon: Key.Semicolon,
  quote: Key.Quote,
  comma: Key.Comma,
  period: Key.Period,
  slash: Key.Slash,
  grave: Key.Grave,

  numpad0: Key.NumPad0,
  numpad1: Key.NumPad1,
  numpad2: Key.NumPad2,
  numpad3: Key.NumPad3,
  numpad4: Key.NumPad4,
  numpad5: Key.NumPad5,
  numpad6: Key.NumPad6,
  numpad7: Key.NumPad7,
  numpad8: Key.NumPad8,
  numpad9: Key.NumPad9,
  numpadadd: Key.Add,
  numpadsubtract: Key.Subtract,
  numpadmultiply: Key.Multiply,
  numpaddivide: Key.Divide,
  numpaddecimal: Key.Decimal,
  numpadenter: Key.Enter,
};

/**
 * Punctuation, mapped to the *unshifted* key that produces it.
 *
 * nut-js has no keycode for `"!"` — the keyboard produces it with Shift+1 — so a
 * chord can only ask for the physical key. Typing a string is a different path:
 * `keyboard.type("!")` handles the shift for us. {@link toDriverKey} therefore
 * refuses these tokens and says so, rather than silently sending the wrong key.
 */
const PUNCTUATION_KEYS: Record<string, Key> = {
  '!': Key.Num1,
  '@': Key.Num2,
  '#': Key.Num3,
  $: Key.Num4,
  '%': Key.Num5,
  '^': Key.Num6,
  '&': Key.Num7,
  '*': Key.Multiply,
  '(': Key.Num9,
  ')': Key.Num0,
  '-': Key.Minus,
  _: Key.Minus,
  '=': Key.Equal,
  '+': Key.Add,
  '[': Key.LeftBracket,
  ']': Key.RightBracket,
  '{': Key.LeftBracket,
  '}': Key.RightBracket,
  '\\': Key.Backslash,
  '|': Key.Backslash,
  ';': Key.Semicolon,
  ':': Key.Semicolon,
  "'": Key.Quote,
  '"': Key.Quote,
  ',': Key.Comma,
  '.': Key.Period,
  '<': Key.Comma,
  '>': Key.Period,
  '/': Key.Slash,
  '?': Key.Slash,
  '`': Key.Grave,
  '~': Key.Grave,
  ' ': Key.Space,
};

/** Tokens that need Shift on a US layout, so a bare chord cannot express them. */
const SHIFTED_PUNCTUATION = new Set([
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '<', '>', '?', '~',
]);

/** Raised when a caller passes a key name the agent does not know. */
export class UnknownKeyError extends Error {
  readonly kind = 'bad-key';

  constructor(readonly token: string) {
    super(
      `Unknown key "${token}". Use a single character, or one of: ` +
        `${Object.keys(NAMED_KEYS).sort().slice(0, 24).join(', ')}, …`,
    );
    this.name = 'UnknownKeyError';
  }
}

/** Raised when a chord asks for a character that needs a modifier. */
export class ShiftedKeyError extends Error {
  readonly kind = 'shifted-key';

  constructor(
    readonly token: string,
    hint: string,
  ) {
    super(
      `"${token}" is not a single physical key; a chord cannot ask for it directly. ` +
        `Use ${hint}, or use \`type-text ${token}\` to have the driver produce it.`,
    );
    this.name = 'ShiftedKeyError';
  }
}

/**
 * Normalise one raw key name into a canonical token.
 *
 * Order matters. Aliases win first so `return` becomes `enter`; then the
 * function row, which is a numeric pattern rather than a table; then numpad
 * names; then the named table; and only then a literal single character. That
 * last fallback is what lets `press-key A` and `press-key #` mean what they look
 * like, while still rejecting a misspelling like `crtl`.
 */
export function normaliseKeyName(raw: string): KeyToken {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UnknownKeyError(raw);
  }
  const lower = trimmed.toLowerCase();
  const alias = ALIASES[lower];
  if (alias !== undefined) return alias;
  if (lower.startsWith('f') && /^f([1-9]|1[0-2])$/.test(lower)) {
    return lower;
  }
  if (lower.startsWith('numpad') && NAMED_KEYS[lower] !== undefined) {
    return lower;
  }
  if (NAMED_KEYS[lower] !== undefined) return lower;
  // Fall back to the literal character, so "A" and "!" work as typed.
  if (trimmed.length === 1) return trimmed;
  throw new UnknownKeyError(raw);
}

/** Map a canonical token onto a nut-js key, for use inside a chord. */
export function toDriverKey(token: KeyToken): Key {
  const lower = token.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named !== undefined) return named;

  if (token.length === 1) {
    // A letter or digit is an unambiguous physical key. These are not in
    // NAMED_KEYS because the driver exposes them as `Key.A`, `Key.Num7` and so
    // on, so resolve them straight from the enum.
    const candidates = [token.toUpperCase(), `Num${token}`, `NumPad${token}`];
    for (const candidate of candidates) {
      const resolved = (Key as unknown as Record<string, number | undefined>)[candidate];
      // Enum members are numbers; reverse mappings are strings, so this also
      // rules out the `Key[0] === 'Escape'` style entries.
      if (typeof resolved === 'number') return resolved as Key;
    }

    // Punctuation that needs Shift cannot be expressed as a bare chord.
    if (SHIFTED_PUNCTUATION.has(token)) {
      throw new ShiftedKeyError(token, shiftHint(token));
    }
    const punctuation = PUNCTUATION_KEYS[token];
    if (punctuation !== undefined) return punctuation;
  }

  throw new UnknownKeyError(token);
}

/** Suggest the shifted form, e.g. `shift+1` for `!`. */
function shiftHint(token: string): string {
  const pairs: Record<string, string> = {
    '!': 'shift+1',
    '@': 'shift+2',
    '#': 'shift+3',
    $: 'shift+4',
    '%': 'shift+5',
    '^': 'shift+6',
    '&': 'shift+7',
    '*': 'shift+8',
    '(': 'shift+9',
    ')': 'shift+0',
    _: 'shift+minus',
    '+': 'shift+equal',
    '{': 'shift+leftbracket',
    '}': 'shift+rightbracket',
    '|': 'shift+backslash',
    ':': 'shift+semicolon',
    '"': 'shift+quote',
    '<': 'shift+comma',
    '>': 'shift+period',
    '?': 'shift+slash',
    '~': 'shift+grave',
  };
  return pairs[token] ?? `shift+<key>`;
}

/**
 * True when the token is a modifier that must be held while typing a chord.
 *
 * Exactly these four, because they are the keys the driver presses first and
 * releases last. Anything else in a chord is a key to press while they are held.
 */
export function isModifier(token: KeyToken): boolean {
  return token === 'ctrl' || token === 'shift' || token === 'alt' || token === 'super';
}
