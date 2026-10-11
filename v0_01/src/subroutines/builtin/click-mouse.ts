/**
 * Subroutine: `click-mouse` — click a mouse button, optionally moving there first.
 */

import { type MouseButton, type Subroutine } from '../../contract/index.js';
import { parseCoordinate } from './move-mouse.js';

const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right'];

export const clickMouse: Subroutine = {
  name: 'click-mouse',
  summary: 'click a mouse button, at the cursor or at a given point',
  description:
    'With x and y both given, the cursor is moved there first. With neither, ' +
    'the click happens wherever the cursor already is.',
  params: [
    {
      name: 'button',
      required: false,
      description: 'left, middle or right',
      defaultValue: 'left',
    },
    {
      name: 'times',
      required: false,
      description: 'how many clicks to send',
      defaultValue: '1',
    },
    {
      name: 'x',
      required: false,
      description: 'horizontal position to move to before clicking',
    },
    {
      name: 'y',
      required: false,
      description: 'vertical position to move to before clicking',
    },
  ],

  async entry(ctx) {
    const rawButton = ctx.paramOr('button', 'left').toLowerCase();
    const button = BUTTONS.find((candidate) => candidate === rawButton);
    if (button === undefined) {
      throw new Error(`"${rawButton}" is not a button. Use ${BUTTONS.join(', ')}.`);
    }

    const times = parseCount(ctx.paramOr('times', '1'));
    const at = parseOptionalPoint(ctx.paramOr('x', ''), ctx.paramOr('y', ''));

    ctx.status(at === undefined ? `clicking ${button} x${times}` : `clicking at ${at.x},${at.y}`);
    await ctx.agent.clickMouse({
      button,
      times,
      ...(at !== undefined ? { at } : {}),
    });
    ctx.status(`clicked ${button} x${times}`);
  },
};

/** Both coordinates or neither; one alone is a mistake worth reporting. */
export function parseOptionalPoint(
  rawX: string,
  rawY: string,
): { x: number; y: number } | undefined {
  const hasX = rawX.trim() !== '';
  const hasY = rawY.trim() !== '';
  if (!hasX && !hasY) return undefined;
  if (hasX !== hasY) {
    throw new Error('Give both x and y, or neither.');
  }
  return { x: parseCoordinate(rawX, 'x'), y: parseCoordinate(rawY, 'y') };
}

function parseCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error(`"${raw}" is not a click count between 1 and 20.`);
  }
  return value;
}
