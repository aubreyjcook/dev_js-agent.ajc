/**
 * Command-line parsing for the terminal.
 *
 * The implementation lives in `shared/` so subroutines can accept the same
 * mini-syntax; this module is the terminal's name for it.
 */

export {
  type ParsedCommandLine,
  parseArguments,
  parseCommandLine,
} from '../shared/command-line.js';
