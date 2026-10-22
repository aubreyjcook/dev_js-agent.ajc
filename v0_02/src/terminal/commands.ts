/**
 * Terminal command definitions.
 *
 * Unchanged in spirit from v0_01 — the built-in set is still "control the
 * program, not the machine":
 *
 *   help      what can I type?
 *   list      what is running right now?
 *   stop      stop everything that is running
 *   status    where am I, and what is driving me?
 *   exit      leave this session
 *   shutdown  stop the whole program/daemon
 *
 * v0_02 adds two things:
 *
 *   - `shutdown` is distinct from `exit` once a daemon exists. `exit` means "I
 *     am done with this terminal"; `shutdown` means "stop the service itself".
 *     Conflating them would let any client casually kill work another client is
 *     relying on — and would make `exit` in an attached terminal surprising.
 *   - `status` reports daemon details when it is running inside one, via the
 *     optional `daemon` field. Commands never learn whether they are local or
 *     remote beyond that; anything more would couple them to the transport.
 */

import {
  type AgentStatusSource,
  type DaemonSummary,
  type Logger,
  type Subroutine,
  type SubroutineApi,
  isActiveState,
} from '../contract/index.js';
import { formatElapsed, formatTaskRow, formatUsage } from './render.js';

/** Everything a command is allowed to touch. */
export interface CommandContext {
  /** Narrow, read-only view of the agent: commands never send input themselves. */
  readonly agent: AgentStatusSource;
  readonly subroutines: SubroutineApi;
  /** Writes one line to whoever issued the command. */
  readonly write: (line: string) => void;
  /** End this session only. In daemon mode, this detaches the client. */
  readonly requestExit: () => void;
  /** Stop the program (standalone) or the daemon (daemon mode). */
  readonly requestShutdown: () => void;
  readonly log: Logger;
  /** Present only when serving as a daemon. */
  readonly daemon?: DaemonSummary;
}

export interface Command {
  readonly name: string;
  /** Extra names that resolve to this command. */
  readonly aliases?: readonly string[];
  /** One-line summary for `help`. */
  readonly summary: string;
  /** Longer text for `help <name>`. */
  readonly usage?: string;
  readonly run: (context: CommandContext, args: readonly string[]) => Promise<void> | void;
}

const HELP: Command = {
  name: 'help',
  aliases: ['?', 'h'],
  summary: 'show the built-in commands and every available subroutine',
  usage: 'help [command-or-subroutine]',
  run: (context, args) => {
    const topic = args[0]?.toLowerCase();
    if (topic !== undefined) {
      writeTopic(context, topic);
      return;
    }

    context.write('Built-in commands');
    for (const command of [...COMMANDS].sort(byName)) {
      context.write(`  ${command.name.padEnd(12)} ${command.summary}`);
    }
    context.write('');

    const subroutines = context.subroutines.list();
    context.write('Subroutines');
    if (subroutines.length === 0) {
      context.write('  (none registered)');
    }
    for (const subroutine of subroutines) {
      context.write(`  ${formatUsage(subroutine).padEnd(34)} ${subroutine.summary}`);
    }
    context.write('');
    context.write('  Text in "quotes" is passed through as one argument.');
    context.write('  Use `help <name>` for the arguments a subroutine expects.');
    context.write('  `exit` leaves this terminal; `shutdown` stops the daemon.');
  },
};

const LIST: Command = {
  name: 'list',
  aliases: ['jobs', 'ps'],
  summary: 'show what is running right now',
  usage: 'list [--all]',
  run: (context, args) => {
    const showFinished = args.some((argument) => /^--?(all|finished|a)$/i.test(argument));
    const active = context.subroutines.active();

    context.write(`Running subroutines: ${active.length === 0 ? 'none' : active.length}`);
    for (const task of active) context.write(`  ${formatTaskRow(task)}`);

    if (!showFinished) {
      context.write('  (`list --all` also shows recently finished runs)');
      return;
    }

    const finished = context.subroutines.recent();
    if (finished.length === 0) {
      context.write('Recently finished: none');
      return;
    }
    context.write(`Recently finished: ${finished.length}`);
    for (const task of finished) context.write(`  ${formatTaskRow(task)}`);
  },
};

const STOP: Command = {
  name: 'stop',
  aliases: ['kill', 'cancel', 'stopall'],
  summary: 'stop every running subroutine and its input actions',
  usage: 'stop',
  run: async (context, args) => {
    const reason = args.length > 0 ? args.join(' ') : 'Stopped from the terminal';
    const active = context.subroutines.active();
    if (active.length === 0) {
      context.write('Nothing is running.');
      return;
    }

    context.write(`Stopping ${active.length} subroutine(s)…`);
    const stopped = await context.subroutines.stopAll(reason);
    const cancelled = stopped.filter((task) => task.state === 'cancelled').length;
    const alreadyDone = stopped.length - cancelled;
    context.write(
      `Stopped ${stopped.length} run(s): ${cancelled} cancelled` +
        (alreadyDone > 0 ? `, ${alreadyDone} had already finished.` : '.'),
    );
  },
};

const STATUS: Command = {
  name: 'status',
  summary: 'show the agent, its input driver, the host, and the daemon if any',
  usage: 'status',
  run: async (context) => {
    const status = await context.agent.status();
    const { host } = status;
    context.write(`Agent        ${status.name}`);
    context.write(`State        ${status.ready ? 'ready' : 'not started'}`);
    context.write(`Input driver ${host.driver} (${host.live ? 'LIVE' : 'dry run'})`);
    context.write(
      `Host         ${host.hostname} · ${host.platform} ${host.release} · ${host.arch}`,
    );
    context.write(`Node         ${host.nodeVersion}`);
    if (status.cursor !== undefined) {
      context.write(`Cursor       ${status.cursor.x},${status.cursor.y}`);
    }
    context.write(
      `Inputs sent  ${status.inputsPerformed} (${status.activeInputs} in flight)`,
    );

    if (context.daemon !== undefined) {
      context.write(`Daemon       pid ${context.daemon.pid} · ${context.daemon.endpoint}`);
      context.write(`Clients      ${context.daemon.clients}`);
      context.write(`Uptime       ${formatElapsed(Date.parse(context.daemon.startedAt))}`);
    }
  },
};

const EXIT: Command = {
  name: 'exit',
  aliases: ['quit', 'q'],
  summary: 'leave this terminal (in daemon mode: detach, leaving the daemon running)',
  usage: 'exit',
  run: (context) => {
    const active = context.subroutines.active();
    if (context.daemon !== undefined) {
      context.write('Detaching from the daemon. Running work continues.');
      context.requestExit();
      return;
    }
    if (active.length > 0) {
      context.write(`Stopping ${active.length} running subroutine(s) before exit…`);
    }
    context.requestExit();
  },
};

/**
 * Stop the whole service.
 *
 * Deliberately *not* an alias of `exit`. In a daemon, `exit` means "this terminal
 * is done" and must not cancel another client's work; `shutdown` is the explicit
 * request to end the process that owns the device. Keeping them separate is what
 * makes closing one terminal safe.
 */
const SHUTDOWN: Command = {
  name: 'shutdown',
  summary: 'stop the program, or the daemon and every attached client',
  usage: 'shutdown',
  run: (context) => {
    const active = context.subroutines.active();
    if (active.length > 0) {
      context.write(`Stopping ${active.length} running subroutine(s) before shutdown…`);
    }
    if (context.daemon === undefined) {
      context.write('Shutting down.');
    } else {
      context.write(
        `Shutting down the daemon (pid ${context.daemon.pid}); ` +
          `${context.daemon.clients} client(s) will be disconnected.`,
      );
    }
    context.requestShutdown();
  },
};

/** The built-in command set. */
export const COMMANDS: readonly Command[] = [HELP, LIST, STOP, STATUS, EXIT, SHUTDOWN];

/** Find a command by name or alias. */
export function findCommand(name: string): Command | undefined {
  const needle = name.toLowerCase();
  return COMMANDS.find(
    (command) => command.name === needle || command.aliases?.includes(needle) === true,
  );
}

/** Every name a user could type for a built-in, for the banner and suggestions. */
export function commandNames(): string[] {
  return COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

function byName(a: Command, b: Command): number {
  return a.name.localeCompare(b.name);
}

function writeTopic(context: CommandContext, topic: string): void {
  const command = findCommand(topic);
  if (command !== undefined) {
    context.write(`${command.name} — ${command.summary}`);
    if (command.usage !== undefined) context.write(`  usage: ${command.usage}`);
    if (command.aliases !== undefined && command.aliases.length > 0) {
      context.write(`  aliases: ${command.aliases.join(', ')}`);
    }
    return;
  }

  const subroutine: Subroutine | undefined = context.subroutines.get(topic);
  if (subroutine !== undefined) {
    context.write(`${subroutine.name} — ${subroutine.summary}`);
    if (subroutine.description !== undefined) context.write(`  ${subroutine.description}`);
    context.write(`  usage: ${formatUsage(subroutine)}`);
    for (const param of subroutine.params ?? []) {
      const requirement = param.required
        ? 'required'
        : `optional, default ${JSON.stringify(param.defaultValue ?? '')}`;
      context.write(`    ${param.name} — ${param.description} (${requirement})`);
    }
    return;
  }

  context.write(`No command or subroutine named "${topic}". Try \`help\`.`);
}

/** Re-exported so a caller can reason about a row without importing contract. */
export { isActiveState };
