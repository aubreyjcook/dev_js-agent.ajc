/**
 * Subroutine: `demo` — a worked example of composing agent primitives.
 *
 * This is the template to copy when adding a new behaviour: wait for the user,
 * check the cancellation signal between every step, report progress with
 * `ctx.status`, and never touch the operating system directly.
 */

import { type Subroutine } from '../../contract/index.js';

export const demo: Subroutine = {
  name: 'demo',
  summary: 'example run: count down, click once, then type a line',
  description:
    'A short, safe sequence that demonstrates the subroutine contract: a ' +
    'cancellable countdown, an optional mouse move, a click, and some typing. ' +
    'Cancel it at any point with `stop`.',
  params: [
    {
      name: 'text',
      required: false,
      description: 'the line to type once the click lands',
      defaultValue: 'hello from the subroutine layer',
    },
    {
      name: 'wait-ms',
      required: false,
      description: 'how long to wait before moving, so you can focus a target',
      defaultValue: '5000',
    },
    {
      name: 'x',
      required: false,
      description: 'optional cursor x; with y, the cursor moves there',
    },
    {
      name: 'y',
      required: false,
      description: 'optional cursor y; with x, the cursor moves there',
    },
  ],

  async entry(ctx) {
    // Defaults come from the declaration above. `paramOr` is used rather than
    // `param` because every argument here is optional.
    const text = ctx.paramOr('text', 'hello from the subroutine layer');
    const waitMs = parseWait(ctx.paramOr('wait-ms', '5000'));
    const x = ctx.paramOr('x', '');
    const y = ctx.paramOr('y', '');

    // Count down in one-second slices so `stop` interrupts almost immediately
    // and the status line keeps the user informed. The final slice may be
    // shorter than a second when the total is not a whole number of seconds.
    const seconds = Math.ceil(waitMs / 1_000);
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      ctx.signal.throwIfCancelled();
      ctx.status(`starting in ${remaining}s — focus the target window now`);
      await ctx.sleep(Math.min(1_000, waitMs));
    }

    // Both coordinates or neither: a single axis would be ambiguous, and this
    // subroutine documents the pair as optional. Real coordinate parsing lives
    // in move-mouse; this keeps the demo self-contained and short.
    if (x !== '' && y !== '') {
      ctx.signal.throwIfCancelled();
      const point = { x: Number(x), y: Number(y) };
      if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
        throw new Error(`x and y must be whole pixels; got "${x}", "${y}".`);
      }
      ctx.status(`moving to ${point.x},${point.y}`);
      await ctx.agent.moveMouse({ ...point, durationMs: 400 });
      // A short settle between gestures: applications often ignore a click that
      // lands in the same frame as the cursor move.
      await ctx.sleep(150);
    }

    // Check before every gesture, not only at the top: `stop` should take effect
    // wherever the run happens to be, including between two awaits.
    ctx.signal.throwIfCancelled();
    ctx.status('clicking');
    await ctx.agent.clickMouse({ button: 'left' });
    await ctx.sleep(150);

    ctx.signal.throwIfCancelled();
    ctx.status(`typing ${text.length} char(s)`);
    await ctx.agent.typeText({ text });

    ctx.status('done');
  },
};

/** A wait is capped so a mistyped value cannot park the run for a day. */
function parseWait(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 300_000) {
    throw new Error(`"${raw}" is not a wait between 0 and 300000 ms.`);
  }
  return value;
}
