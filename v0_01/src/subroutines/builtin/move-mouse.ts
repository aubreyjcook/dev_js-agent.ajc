/**
 * Subroutine: `move-mouse` — move the cursor to a point on screen.
 */

import { TIMING, type Subroutine } from '../../contract/index.js';

export const moveMouse: Subroutine = {
  name: 'move-mouse',
  summary: 'move the cursor to an x,y position, optionally pacing the travel',
  description:
    'Duration 0 teleports the cursor; anything larger interpolates the path so ' +
    'the movement looks human. The point must be inside the screen.',
  params: [
    { name: 'x', required: true, description: 'horizontal pixel position' },
    { name: 'y', required: true, description: 'vertical pixel position' },
    {
      name: 'duration-ms',
      required: false,
      description: 'travel time in milliseconds; 0 teleports',
      defaultValue: String(TIMING.moveDuration),
    },
  ],

  async entry(ctx) {
    const x = parseCoordinate(ctx.param('x'), 'x');
    const y = parseCoordinate(ctx.param('y'), 'y');
    const durationMs = parseDuration(ctx.paramOr('duration-ms', ''));

    ctx.status(`moving to ${x},${y}`);
    await ctx.agent.moveMouse({ x, y, durationMs });
    ctx.status(`cursor at ${x},${y}`);
  },
};

export function parseCoordinate(raw: string, axis: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`"${raw}" is not a whole-pixel ${axis} coordinate.`);
  }
  if (value < 0) {
    throw new Error(`${axis} must not be negative; got ${value}.`);
  }
  return value;
}

function parseDuration(raw: string): number {
  if (raw.trim() === '') return TIMING.moveDuration;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`"${raw}" is not a valid duration in milliseconds.`);
  }
  return value;
}
