/**
 * Terminal command definitions.
 *
 * The built-in set is deliberately tiny, as specified:
 *
 *   help  — what can I type?
 *   list  — what is running right now?
 *   stop  — stop everything that is running
 *   exit  — leave the program
 *
 * `status` rides along because it costs nothing and makes the banner state
 * inspectable after the fact. Anything else should become a subroutine, not a
 * built-in command — that is the whole point of the split.
 */

import {
  type AgentStatusSource,
  type Logger,
  type Subroutine,
  type SubroutineApi,
  type TaskSnapshot,
  isActiveState,
} from '../contract/index.js';

/** Everything a command is allowed to touch. */
export interface CommandContext {
  /** Narrow, read-only view of the agent: commands never send input themselves. */
  readonly agent: AgentStatusSource;
  readonly subroutines: SubroutineApi;
  /** Writes one line to the terminal. */
  readonly write: (line: string) => void;
  /** Ask the session to terminate; the session owns the shutdown sequence. */
  readonly requestExit: () => void;
  readonly log: Logger;
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
    for (const task of active) context.write(`  ${formatTask(task)}`);

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
    for (const task of finished) context.write(`  ${formatTask(task)}`);
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
  summary: 'show the agent, its input driver and the host it runs on',
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
  },
};

const EXIT: Command = {
  name: 'exit',
  aliases: ['quit', 'q'],
  summary: 'stop everything and close the program',
  usage: 'exit',
  run: (context) => {
    const active = context.subroutines.active();
    if (active.length > 0) {
      context.write(`Stopping ${active.length} running subroutine(s) before exit…`);
    }
    context.requestExit();
  },
};

/** The built-in command set. */
export const COMMANDS: readonly Command[] = [HELP, LIST, STOP, STATUS, EXIT];

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

  const subroutine = context.subroutines.get(topic);
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

/** Render "name <required> [optional]" for help output. */
function formatUsage(subroutine: Subroutine): string {
  const params = (subroutine.params ?? []).map((param) => {
    // A rest parameter may span several words, so mark it as variadic.
    const inner = param.rest === true ? `${param.name} ...` : param.name;
    return param.required ? `<${inner}>` : `[${inner}]`;
  });
  return [subroutine.name, ...params].join(' ');
}

function formatTask(task: TaskSnapshot): string {
  const detail = task.detail !== undefined ? ` · ${task.detail}` : '';
  const error = task.error !== undefined ? ` · ${task.error.message}` : '';
  const state = isActiveState(task.state) ? `${task.state} ${elapsed(task)}` : task.state;
  return `${task.id.padEnd(8)} ${task.name.padEnd(14)} ${state}${detail}${error}`;
}

function elapsed(task: TaskSnapshot): string {
  const since = task.startedAt ?? task.createdAt;
  const seconds = Math.max(0, (Date.now() - since) / 1_000);
  return `${seconds.toFixed(1)}s`;
}
