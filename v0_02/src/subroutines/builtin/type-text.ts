/**
 * Subroutine: `type-text` — type a string of characters.
 */

import { TIMING, type Subroutine } from '../../contract/index.js';
import { firstUnsupportedCharacter } from '../../shared/text.js';

export const typeText: Subroutine = {
  name: 'type-text',
  summary: 'type a string of characters into the focused window',
  description:
    'Types the text one character at a time. Only printable ASCII is supported ' +
    'by the current input driver. Use `focus <window>` first to make sure the ' +
    'text lands where you expect.',
  params: [
    {
      name: 'text',
      required: true,
      description: 'the characters to type; quote them to keep exact spacing',
      rest: true,
    },
    {
      name: 'char-delay-ms',
      required: false,
      description: 'pause between characters, in milliseconds',
      defaultValue: String(TIMING.charDelay),
    },
  ],

  async entry(ctx) {
    // `text` absorbs the remaining arguments, so a trailing number could be
    // either text or the pacing. When there is more than one word, read a final
    // number as pacing — `type-text hello 50` — because that is the reading a
    // person expects, and a numeric word is rarely the intent.
    const rawText = ctx.param('text');
    const parts = rawText.split(' ').filter((part) => part.length > 0);
    const trailing = parts.length > 1 ? parts[parts.length - 1] : undefined;
    const looksLikePacing = trailing !== undefined && /^\d+$/.test(trailing);
    const text = looksLikePacing ? parts.slice(0, -1).join(' ') : rawText;

    const delayOverride = looksLikePacing
      ? ctx.paramOr('char-delay-ms', trailing)
      : ctx.paramOr('char-delay-ms', '');
    const charDelayMs = parseDelay(delayOverride, TIMING.charDelay);

    if (text === '') {
      throw new Error('Nothing to type.');
    }

    // Fail before the first keystroke rather than halfway through a sentence.
    const unsupported = firstUnsupportedCharacter(text);
    if (unsupported !== undefined) {
      throw new Error(
        `Cannot type ${JSON.stringify(unsupported)}: the input driver reproduces ` +
          'printable ASCII only. Strip or transliterate the text first.',
      );
    }

    ctx.log.debug(`typing ${text.length} character(s)`);
    ctx.status(`typing ${text.length} chars`);
    // Send the text in chunks rather than one giant driver call. Two reasons:
    // a chunk boundary is a place where cancellation and progress can happen,
    // and the driver's per-character delay then applies across the whole string
    // without one unbounded await.
    const chunkSize = 40;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      ctx.signal.throwIfCancelled();
      const chunk = text.slice(offset, offset + chunkSize);
      await ctx.agent.typeText({ text: chunk, charDelayMs });
      // `Math.min` because the final chunk is usually short.
      ctx.status(`typed ${Math.min(offset + chunkSize, text.length)}/${text.length} chars`);
    }
    ctx.status(`typed ${text.length} chars`);
  },
};

/** Accept a numeric delay, falling back rather than failing on junk.
 *  An empty string means "not supplied"; `0` is a real value (type as fast as
 *  the driver can), so the emptiness check comes first. */
export function parseDelay(raw: string, fallback: number): number {
  if (raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`"${raw}" is not a valid delay in milliseconds.`);
  }
  return value;
}
