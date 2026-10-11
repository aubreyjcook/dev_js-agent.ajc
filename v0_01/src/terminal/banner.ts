/**
 * Terminal presentation: the banner and the prompt.
 *
 * Only the terminal draws to stdout. The agent and the subroutines report what
 * they are doing to the task registry and the logger, and this file renders it.
 */

import type { AgentHostSource } from '../contract/index.js';

export interface BannerOptions {
  version: string;
  /** True when input actually reaches the keyboard and mouse. */
  live: boolean;
  /** Parent logger's threshold, shown for troubleshooting. */
  logLevel: string;
  commands: readonly string[];
  subroutines: readonly string[];
}

/** Multi-line banner printed once, before the first prompt. */
export function renderBanner(agent: AgentHostSource, options: BannerOptions): string[] {
  const host = agent.hostInfo();
  const column = (values: readonly string[]): string => values.join(', ');
  return [
    '',
    `  js-agent ${options.version}  ·  target 0.01`,
    `  input driver   ${host.driver} (${options.live ? 'LIVE — real keyboard and mouse' : 'dry run — nothing is sent'})`,
    `  host           ${host.hostname} · ${host.platform} ${host.release} · ${host.arch} · node ${host.nodeVersion}`,
    `  log level      ${options.logLevel}`,
    `  commands       ${column(options.commands)}`,
    `  subroutines    ${column(options.subroutines)}`,
    '',
    ...(options.live
      ? [
          '  !! LIVE input is on. Subroutines will drive this machine for real.',
          '     Keep a hand near Ctrl+C, and prefer `--dry-run` while developing.',
          '',
        ]
      : []),
    '  Type `help` for commands, `help <name>` for one topic, `exit` to quit.',
    '',
  ];
}

/** True when the runtime's stdin can be used for an interactive prompt. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
