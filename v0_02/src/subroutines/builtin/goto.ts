/**
 * Subroutine: `goto` — open a URL in the default browser.
 *
 * On Windows the most reliable route is the Run dialog (`Win`+`R`), because it
 * reuses whatever browser is already the default and hands the URL to the shell
 * rather than to a guessed executable path.
 */

import { parseArguments } from '../../shared/command-line.js';
import type { Subroutine } from '../../contract/index.js';
/** Characters allowed in a URL that is typed into the Run dialog. */
const SAFE_URL = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

export const goto: Subroutine = {
  name: 'goto',
  summary: 'open a URL in the default browser',
  description:
    'Opens the Run dialog (Win+R) and hands the URL to the shell. Pass --new to ' +
    'ask for a new window; that relies on the browser understanding the command ' +
    'line, so a browser that ignores it will simply reuse the current window.',
  params: [
    {
      name: 'url',
      required: true,
      description: 'the address to open, with or without a scheme',
      rest: true,
    },
  ],

  async entry(ctx) {
    // `url` soaks up the remaining words; split flags back out of the tail so
    // `goto --new example.com` and `goto example.com --new` both work.
    const raw = ctx.param('url');
    const flags = parseArguments(raw).filter((part) => part.startsWith('-'));
    const address = raw
      .split(/\s+/)
      .filter((part) => part.length > 0 && !part.startsWith('-'))
      .join('');
    const url = normaliseUrl(address);
    const wantsNewWindow = flags.some((flag) => /^--?(new|new-window)$/i.test(flag));

    if (!SAFE_URL.test(url)) {
      throw new Error(
        `Refusing to type "${url}": it contains characters that are not valid ` +
          'in a URL. Only plain http(s) addresses are safe to open this way.',
      );
    }

    const command = wantsNewWindow ? `cmd /c start "" "${url}"` : url;

    ctx.status(`opening ${url}`);
    ctx.log.info(`Run dialog -> ${command}`);

    // Clear any pending dialog state first, so we cannot type into the wrong box.
    ctx.signal.throwIfCancelled();
    await ctx.agent.pressKey({ chord: ['escape'] });
    await ctx.sleep(120);

    ctx.signal.throwIfCancelled();
    await ctx.agent.pressKey({ chord: ['super', 'r'] });
    // The Run dialog needs a moment before it will accept input.
    await ctx.sleep(650);

    ctx.signal.throwIfCancelled();
    await ctx.agent.typeText({ text: command });
    await ctx.sleep(180);

    ctx.signal.throwIfCancelled();
    await ctx.agent.pressKey({ chord: ['enter'] });
    ctx.status(`opened ${url}`);
  },
};

/**
 * Add a scheme when the caller omitted one, and reject anything that is not an
 * HTTP(S) address.
 *
 * Anything else (`file:`, `javascript:`, a UNC path) would be typed into a shell
 * dialog, so it is refused rather than escaped.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('No URL given.');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a URL I can open.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to open a "${parsed.protocol}" address; only http and https are supported.`,
    );
  }
  return parsed.toString();
}
