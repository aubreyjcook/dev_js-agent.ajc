/**
 * Terminal presentation: banners and prompts.
 *
 * Only the front ends draw to stdout. The agent and the subroutines report to
 * the task registry and the logger, and the front ends render that.
 *
 * v0_02 adds a banner for attached clients. It is separate from the local one
 * because it answers different questions: a local session needs to know which
 * driver it owns, while a client needs to know *which daemon* it is talking to
 * and where that daemon is listening.
 */

import type { AgentHostSource, DaemonInfo } from '../contract/index.js';

export interface BannerOptions {
  version: string;
  mode: 'standalone' | 'daemon';
  /** True when input actually reaches the keyboard and mouse. */
  live: boolean;
  /** Parent logger's threshold, shown for troubleshooting. */
  logLevel: string;
  commands: readonly string[];
  subroutines: readonly string[];
}

/** Multi-line banner printed by a local (standalone or daemon-host) session. */
export function renderBanner(agent: AgentHostSource, options: BannerOptions): string[] {
  const host = agent.hostInfo();
  const column = (values: readonly string[]): string => values.join(', ');
  return [
    '',
    `  js-agent ${options.version}  ·  target 0.02  ·  ${options.mode} mode`,
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

/**
 * Banner for a client attached to a running daemon.
 *
 * The important line is the endpoint: it tells the user *which* daemon they are
 * driving, which matters the moment two are running on one machine.
 */
export function renderAttachBanner(info: DaemonInfo, version: string): string[] {
  return [
    '',
    `  js-agent ${version} client  ·  attached to daemon`,
    `  daemon         pid ${info.pid} · ${info.endpoint} (${info.endpointKind})`,
    `  daemon version ${info.version}`,
    `  input driver   ${info.host.driver} (${info.live ? 'LIVE — real keyboard and mouse' : 'dry run — nothing is sent'})`,
    `  host           ${info.host.hostname} · ${info.host.platform} · node ${info.host.nodeVersion}`,
    `  clients        ${info.clients}`,
    '',
    '  Commands run in the daemon, so any terminal attached to it sees the same',
    '  state. `exit` detaches and leaves the daemon running; `shutdown` stops it.',
    '',
  ];
}

/** True when the runtime's stdin can be used for an interactive prompt. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
