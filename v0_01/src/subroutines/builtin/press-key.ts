/**
 * Subroutine: `press-key` — press one key, or hold a chord such as `ctrl+c`.
 */

import { TIMING, type Subroutine } from '../../contract/index.js';
import { parseDelay } from './type-text.js';

export const pressKey: Subroutine = {
  name: 'press-key',
  summary: 'press a key, or hold a chord such as ctrl+shift+escape',
  description:
    'Joins the keys with "+" to hold them together. Modifiers ("ctrl", ' +
    '"shift", "alt", "super") are pressed first and always released, even if ' +
    'the press fails. Key names are layout-independent: "enter", "escape", ' +
    '"pageup", "f5", "numpad4", or a single character like "a" or "#".',
  params: [
    {
      name: 'chord',
      required: true,
      description: 'keys joined with "+", e.g. ctrl+shift+t or enter',
    },
    {
      name: 'repeat',
      required: false,
      description: 'how many times to send the chord',
      defaultValue: '1',
    },
    {
      name: 'key-delay-ms',
      required: false,
      description: 'pause after each press, in milliseconds',
      defaultValue: String(TIMING.keyDelay),
    },
  ],

  async entry(ctx) {
    // The chord is written as `ctrl+shift+t`. Splitting on "+" is deliberately
    // forgiving: trimming each part and dropping empties means `ctrl + t` and
    // `ctrl++t` both work, rather than failing on a stray space or plus.
    const raw = ctx.param('chord');
    const chord = raw
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (chord.length === 0) {
      throw new Error('No keys given. Try: press-key ctrl+c');
    }

    // Bounded on purpose: a mistyped repeat count should be rejected, not turn
    // into ten thousand keypresses that the user cannot interrupt.
    const repeat = parseCount(ctx.paramOr('repeat', '1'));
    const keyDelayMs = parseDelay(ctx.paramOr('key-delay-ms', ''), TIMING.keyDelay);

    // Status before the work, then after every iteration: `list` can show
    // progress while the loop runs, not only once it finishes.
    ctx.status(`pressing ${chord.join('+')} x${repeat}`);
    for (let index = 0; index < repeat; index += 1) {
      // Between steps is where cancellation is honoured. The agent checks it
      // again before each driver action; doing it here means a multi-press run
      // stops promptly instead of finishing the loop first.
      ctx.signal.throwIfCancelled();
      await ctx.agent.pressKey({ chord, keyDelayMs });
      ctx.status(`pressed ${chord.join('+')} ${index + 1}/${repeat}`);
    }
  },
};

function parseCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`"${raw}" is not a repeat count between 1 and 100.`);
  }
  return value;
}
