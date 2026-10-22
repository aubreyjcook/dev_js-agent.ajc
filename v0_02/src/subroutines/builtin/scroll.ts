/**
 * Subroutine: `scroll` — turn the mouse wheel.
 */

import type { Subroutine } from '../../contract/index.js';

export const scroll: Subroutine = {
  name: 'scroll',
  summary: 'scroll the wheel up or down, left or right',
  description:
    'Positive steps scroll down (or right); negative steps scroll up (or ' +
    'left). One step is roughly three text lines, though the exact distance is ' +
    'set by the operating system.',
  params: [
    { name: 'steps', required: true, description: 'signed number of wheel steps' },
    {
      name: 'axis',
      required: false,
      description: 'vertical or horizontal',
      defaultValue: 'vertical',
    },
  ],

  async entry(ctx) {
    // `Number('')` is 0, so an empty argument would look like a valid no-op.
    // The registry already rejects a missing `steps`, but the integer check is
    // what catches "1.5" and "abc".
    const steps = Number(ctx.param('steps'));
    if (!Number.isInteger(steps)) {
      throw new Error(`"${ctx.param('steps')}" is not a whole number of steps.`);
    }

    // Validated into a narrowed type before it reaches the contract, so the
    // agent never has to defend against an unknown axis.
    const rawAxis = ctx.paramOr('axis', 'vertical').toLowerCase();
    if (rawAxis !== 'vertical' && rawAxis !== 'horizontal') {
      throw new Error(`"${rawAxis}" is not an axis. Use vertical or horizontal.`);
    }

    // The sign carries the direction; the agent and driver only ever see
    // "positive steps" and decide down/right from the axis.
    ctx.status(`scrolling ${rawAxis} ${steps}`);
    await ctx.agent.scroll({ axis: rawAxis, steps });
    ctx.status(`scrolled ${steps} step(s)`);
  },
};
