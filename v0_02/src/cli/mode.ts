/**
 * Choosing a mode.
 *
 * The requirement that shapes this file: **the user decides when the program
 * first runs**. So the chooser is a first-class part of startup, not a flag
 * nobody discovers.
 *
 * But a prompt is also a liability. It must not appear when there is no one to
 * answer it, or scripts break. The rules are therefore:
 *
 *   1. An explicit mode always wins. No prompt.
 *   2. Non-interactive with `--exec` defaults to standalone: a script asked for
 *      commands, not for a service.
 *   3. Non-interactive without `--exec`, with no mode, is an error. Guessing here
 *      would mean a cron job silently starting a daemon.
 *   4. Only a real terminal gets the menu.
 *
 * The menu also reflects reality: if a daemon is already running, "attach"
 * becomes the interesting option and "daemon" is not offered, because starting a
 * second one would fail.
 */

import { createInterface } from 'node:readline/promises';

import type { DaemonLookup } from '../daemon/discovery.js';
import { type CliConfig, type RunMode } from './config.js';

/** Raised when a mode cannot be decided, with a message meant for the user. */
export class ModeChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeChoiceError';
  }
}

export interface ModeChoiceOptions {
  config: CliConfig;
  /** What discovery found, if anything. */
  daemon: DaemonLookup | null;
  interactive: boolean;
  write?: (line: string) => void;
}

interface MenuOption {
  mode: RunMode;
  label: string;
  detail: string;
}

/**
 * Decide how to run.
 *
 * Throws {@link ModeChoiceError} when no safe decision exists; the caller turns
 * that into a message and exit code 2.
 */
export async function chooseMode(options: ModeChoiceOptions): Promise<RunMode> {
  const { config, daemon, interactive } = options;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (config.mode !== undefined) return config.mode;

  if (!interactive) {
    if (config.exec.length > 0) return 'standalone';
    throw new ModeChoiceError(
      'No mode chosen, and stdin is not a terminal. ' +
        'Pass --mode standalone, --mode daemon or --mode attach.',
    );
  }

  const reachable = daemon !== null && daemon.reachable;
  const menu: MenuOption[] = [
    { mode: 'standalone', label: 'standalone', detail: 'this terminal owns the keyboard and mouse (default)' },
  ];

  if (reachable) {
    menu.push({
      mode: 'attach',
      label: 'attach',
      detail: `send commands to the running daemon (pid ${daemon.record.pid}) on ${daemon.record.endpoint.kind === 'tcp' ? `tcp port ${daemon.record.endpoint.port}` : daemon.record.endpoint.path}`,
    });
  } else {
    menu.push({
      mode: 'daemon',
      label: 'daemon',
      detail: 'run as a service; any terminal can send commands',
    });
  }

  write('');
  write('  How should js-agent run?');
  write('');
  menu.forEach((option, index) => {
    write(`    ${index + 1}) ${option.label.padEnd(11)} ${option.detail}`);
  });
  write('');
  if (reachable) {
    write('  A daemon is already running; use --stop-daemon to stop it first.');
  } else if (daemon !== null) {
    write('  A stale daemon record was found; it will be replaced.');
  }
  write('');

  const answer = await ask(interactive ? '  choose [1]: ' : '');
  const chosen = interpret(answer, menu);
  if (chosen !== undefined) return chosen;

  throw new ModeChoiceError(
    `"${answer}" is not one of the options (${menu.map((option, index) => `${index + 1}=${option.label}`).join(', ')}).`,
  );
}

/** Map an answer (`""`, `1`, `attach`, …) to a mode. */
export function interpret(answer: string, menu: readonly MenuOption[]): RunMode | undefined {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '') return menu[0]?.mode;

  const byNumber = Number(trimmed);
  if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= menu.length) {
    return menu[byNumber - 1]?.mode;
  }
  return menu.find((option) => option.mode === trimmed)?.mode;
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    // EOF (Ctrl+D) or a closed stdin: treat as "accept the default".
    return '';
  } finally {
    rl.close();
  }
}
