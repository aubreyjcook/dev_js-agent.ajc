/**
 * The built-in subroutine catalogue.
 *
 * One behaviour per file, and this barrel is the only place that knows the whole
 * set. Adding a subroutine means adding a file next to these and one line here;
 * nothing in `src/core` changes, and nothing in `src/terminal` changes.
 */

import type { Subroutine } from '../../contract/index.js';
import { clickMouse } from './click-mouse.js';
import { demo } from './demo.js';
import { goto } from './goto.js';
import { moveMouse } from './move-mouse.js';
import { pressKey } from './press-key.js';
import { scroll } from './scroll.js';
import { typeText } from './type-text.js';

export { clickMouse } from './click-mouse.js';
export { demo } from './demo.js';
export { goto, normaliseUrl } from './goto.js';
export { moveMouse, parseCoordinate } from './move-mouse.js';
export { pressKey } from './press-key.js';
export { scroll } from './scroll.js';
export { typeText } from './type-text.js';

/**
 * Every built-in subroutine, in the order `help` presents them.
 *
 * The order is a deliberate presentation choice, grouped by what a reader is
 * likely to want first: a single key, then typing, then pointer actions, then
 * the two composite behaviours.
 */
export const builtinSubroutines: readonly Subroutine[] = [
  pressKey,
  typeText,
  moveMouse,
  clickMouse,
  scroll,
  goto,
  demo,
];
