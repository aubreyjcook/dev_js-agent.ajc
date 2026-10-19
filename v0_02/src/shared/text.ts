/**
 * Character set the input layer can reproduce.
 *
 * Declared here, in shared code, rather than inside the driver, so that a
 * subroutine can validate its own input *before* it starts moving the mouse —
 * failing fast beats typing half a sentence and then hitting a wall.
 */

/** The printable ASCII range, which a keycode-based driver can reproduce. */
export const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/** The first character that cannot be typed, or `undefined` when all can. */
export function firstUnsupportedCharacter(text: string): string | undefined {
  return [...text].find((character) => !/[\x20-\x7E]/.test(character));
}
