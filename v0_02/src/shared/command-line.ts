/**
 * Splitting a command line into a name and arguments.
 *
 * Lives in `shared/` because both the terminal (which reads the prompt) and
 * individual subroutines (which may accept a mini-syntax in one argument) need
 * to agree on how quotes and escapes work. It has nothing to do with hardware
 * input, so it does not belong in `core/`.
 */

export interface ParsedCommandLine {
  /** Lowercase command name, e.g. `type-text`. Empty for a blank line. */
  name: string;
  /** Arguments, with quoting resolved. */
  args: string[];
  /** Everything after the command name, verbatim, for `help <name>`. */
  rest: string;
}

const ARGUMENT_PATTERN = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
const UNESCAPE_PATTERN = /\\(.)/g;

/**
 * Split a line into a command and its arguments.
 *
 * `type-text "hello there"` yields `{ name: 'type-text', args: ['hello there'] }`.
 */
export function parseCommandLine(input: string): ParsedCommandLine {
  const line = input.replace(/\r?\n$/, '').trim();
  if (line.length === 0) {
    return { name: '', args: [], rest: '' };
  }

  const separator = line.search(/\s/);
  const name = (separator === -1 ? line : line.slice(0, separator)).toLowerCase();
  const rest = separator === -1 ? '' : line.slice(separator + 1).trim();

  return { name, args: parseArguments(rest), rest };
}

/**
 * Split an argument string, honouring single and double quotes.
 *
 * A dedicated matcher is used rather than a lookbehind split so that
 * `type-text "say \"hi\""` behaves predictably on every supported Node version.
 */
export function parseArguments(input: string): string[] {
  const args: string[] = [];
  ARGUMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ARGUMENT_PATTERN.exec(input)) !== null) {
    const [, doubleQuoted, singleQuoted, bare] = match;
    if (doubleQuoted !== undefined) {
      args.push(unescape(doubleQuoted));
    } else if (singleQuoted !== undefined) {
      args.push(unescape(singleQuoted));
    } else if (bare !== undefined) {
      args.push(bare);
    }
  }
  return args;
}

function unescape(value: string): string {
  return value.replace(UNESCAPE_PATTERN, '$1');
}
