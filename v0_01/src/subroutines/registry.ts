/**
 * The subroutine registry.
 *
 * Holds the catalogue of invokable behaviours and runs them as tracked,
 * cancellable tasks. This is the *only* bridge between the terminal and the
 * subroutines, and it only ever talks to the agent through the `AgentApi`
 * interface — which is what lets the two halves be developed and swapped
 * independently.
 *
 * {@link SubroutineRegistry.run} never rejects once a subroutine exists and has
 * been accepted: whatever happens inside it is captured in the returned
 * {@link SubroutineRunResult}, so a misbehaving subroutine cannot take the
 * terminal down with it. Only "no such subroutine", "already running" and
 * "bad arguments" throw, because those are caller mistakes.
 */

import {
  type AgentApi,
  type CancellationSignal,
  type Logger,
  type PrepareRunResult,
  type PreparedRun,
  type Subroutine,
  type SubroutineApi,
  type SubroutineContext,
  type SubroutineParam,
  type SubroutineRunResult,
  type TaskSnapshot,
  OperationCancelledError,
  cancellableSleep,
  isActiveState,
} from '../contract/index.js';
import { toError } from '../core/agent.js';
import type { TaskRegistry } from '../core/task-registry.js';

/**
 * The concrete shape behind the opaque {@link PreparedRun}.
 *
 * Callers only ever see the branded type; the registry is the only module that
 * knows what is actually inside.
 */
interface InternalPreparedRun {
  subroutine: Subroutine;
  params: Record<string, string>;
}

export interface SubroutineRegistryOptions {
  agent: AgentApi;
  tasks: TaskRegistry;
  logger: Logger;
  /** Subroutines to register up front. */
  subroutines?: readonly Subroutine[];
}

export class SubroutineRegistry implements SubroutineApi {
  readonly #agent: AgentApi;
  readonly #tasks: TaskRegistry;
  readonly #log: Logger;
  readonly #byName = new Map<string, Subroutine>();
  readonly #order: Subroutine[] = [];
  /**
   * In-flight runs, keyed by task id.
   *
   * These are registered synchronously when a run starts, which is what lets
   * `stopAll` wait for the unwind instead of guessing at a timeout.
   */
  readonly #inFlight = new Map<string, Promise<SubroutineRunResult>>();

  constructor(options: SubroutineRegistryOptions) {
    this.#agent = options.agent;
    this.#tasks = options.tasks;
    this.#log = options.logger.child('subroutines');
    for (const subroutine of options.subroutines ?? []) this.register(subroutine);
  }

  /** Add a subroutine. Throws on a duplicate name, which is a programming error. */
  register(subroutine: Subroutine): this {
    const name = normaliseName(subroutine.name);
    if (name.length === 0) {
      throw new Error('A subroutine needs a name.');
    }
    if (this.#byName.has(name)) {
      throw new Error(`Duplicate subroutine name "${name}".`);
    }
    this.#byName.set(name, subroutine);
    this.#order.push(subroutine);
    return this;
  }

  list(): readonly Subroutine[] {
    return this.#order;
  }

  get(name: string): Subroutine | undefined {
    return this.#byName.get(normaliseName(name));
  }

  active(): readonly TaskSnapshot[] {
    return this.#tasks
      .list({ kind: 'subroutine' })
      .filter((task) => isActiveState(task.state));
  }

  recent(filter: { since?: number } = {}): readonly TaskSnapshot[] {
    return this.#tasks
      .list({ kind: 'subroutine' })
      .filter((task) => !isActiveState(task.state))
      .filter((task) => filter.since === undefined || task.createdAt >= filter.since)
      .reverse();
  }

  /**
   * Validate a run without starting it.
   *
   * Synchronous on purpose: the terminal calls this and can report a bad
   * invocation immediately, instead of having to await the whole run (which may
   * take minutes) just to find out the arguments were wrong.
   */
  prepareRun(name: string, rawParams: readonly string[]): PrepareRunResult {
    const subroutine = this.get(name);
    if (subroutine === undefined) {
      const available = [...this.#byName.keys()].sort().join(', ');
      return {
        ok: false,
        reason: 'unknown',
        message: `Unknown subroutine "${name}". Registered: ${available || '(none)'}.`,
      };
    }

    const displayName = subroutine.name;
    const clash = this.active().find(
      (task) => normaliseName(task.name) === normaliseName(displayName),
    );
    if (clash !== undefined) {
      return {
        ok: false,
        reason: 'busy',
        message:
          `"${displayName}" is already running as ${clash.id}. ` +
          'Wait for it, or use `list` and `stop` first.',
      };
    }

    let params: Record<string, string>;
    try {
      params = resolveParams(subroutine, rawParams);
    } catch (error) {
      return { ok: false, reason: 'invalid', message: toError(error).message };
    }

    return { ok: true, run: asPreparedRun({ subroutine, params }) };
  }

  async run(
    name: string,
    rawParams: readonly string[],
    options: { quiet?: boolean } = {},
  ): Promise<SubroutineRunResult> {
    const prepared = this.prepareRun(name, rawParams);
    if (!prepared.ok) throw new Error(prepared.message);
    return this.start(prepared.run, options);
  }

  async start(
    prepared: PreparedRun,
    options: { quiet?: boolean } = {},
  ): Promise<SubroutineRunResult> {
    const { subroutine, params } = prepared as unknown as InternalPreparedRun;    const displayName = subroutine.name;
    const quiet = options.quiet === true;
    const log = this.#log.child(displayName);
    const task = this.#tasks.create('subroutine', displayName);
    const signal = this.#tasks.signalFor(task.id);
    if (signal === undefined) {
      throw new Error(`Task ${task.id} vanished before it could start.`);
    }

    // Publish the running state *before* starting the run.
    //
    // It matters: a subroutine's synchronous prefix (its first `ctx.status(...)`)
    // executes immediately when `#execute` is called, so publishing afterwards
    // would overwrite the subroutine's own detail with "starting".
    this.#tasks.update(task.id, { state: 'running', detail: 'starting' });
    const execution = this.#execute(subroutine, { taskId: task.id, signal, params, log });
    // Registered synchronously so `stopAll` can always await the unwind.
    this.#inFlight.set(task.id, execution);
    if (!quiet) log.info(`started (${task.id})`);

    const result = await execution;
    this.#inFlight.delete(task.id);
    if (!quiet) {
      const message = `${result.outcome} (${task.id})`;
      if (result.outcome === 'completed') log.info(message);
      else log.warn(message);
    }
    return result;
  }

  async stopAll(reason = 'Stopped'): Promise<readonly TaskSnapshot[]> {
    const targets = this.active();
    for (const target of targets) this.#tasks.cancel(target.id, reason);
    // Wait for the runs to unwind, so the caller can print an accurate summary.
    const results = targets.map(
      (target) => this.#inFlight.get(target.id) ?? Promise.resolve(undefined),
    );
    await Promise.all(results);
    return targets.map((target) => this.#tasks.get(target.id) ?? target);
  }

  // -- internals ------------------------------------------------------------

  async #execute(
    subroutine: Subroutine,
    run: {
      taskId: string;
      signal: CancellationSignal;
      params: Record<string, string>;
      log: Logger;
    },
  ): Promise<SubroutineRunResult> {
    const { taskId, signal, params, log } = run;
    const context = createContext({
      agent: this.#agent,
      registry: this.#tasks,
      subroutine,
      taskId,
      signal,
      params,
      log,
    });

    let outcome: SubroutineRunResult['outcome'];
    let failureMessage: string | undefined;
    try {
      await subroutine.entry(context);
      outcome = 'completed';
    } catch (error) {
      const failure = toError(error);
      if (signal.isCancelled || failure instanceof OperationCancelledError) {
        outcome = 'cancelled';
      } else {
        outcome = 'failed';
        failureMessage = failure.message;
        log.error(failure.message);
      }
    }

    // Mark the run finished immediately so `list` and `stop` reflect reality
    // without waiting for in-flight input to drain.
    const detail = context.currentDetail();
    const snapshot = this.#tasks.finish(taskId, outcome, {
      ...(detail !== undefined ? { detail } : {}),
      ...(failureMessage !== undefined
        ? { error: { name: 'SubroutineError', message: failureMessage } }
        : {}),
    });

    // A cancelled or failed run may have left a driver action mid-flight; wait
    // it out so the prompt returns only once the machine has stopped moving.
    await this.#tasks.whenIdle('input');

    return {
      outcome,
      task: snapshot ?? this.#tasks.get(taskId) ?? missingSnapshot(taskId, subroutine),
    };
  }
}

/** Build the object a subroutine is handed. */
function createContext(args: {
  agent: AgentApi;
  registry: TaskRegistry;
  subroutine: Subroutine;
  taskId: string;
  signal: CancellationSignal;
  params: Record<string, string>;
  log: Logger;
}): SubroutineContext & { currentDetail: () => string | undefined } {
  const { agent, registry, subroutine, taskId, signal, log } = args;
  const params = Object.freeze({ ...args.params });
  let detail: string | undefined;

  return {
    agent,
    signal,
    params,
    param(name: string): string {
      const value = params[name];
      if (value === undefined || value === '') {
        throw new Error(
          `"${subroutine.name}" is missing required parameter "${name}".`,
        );
      }
      return value;
    },
    paramOr(name: string, fallback: string): string {
      const value = params[name];
      return value === undefined || value === '' ? fallback : value;
    },
    log: {
      debug: (message: string, ...meta: unknown[]) => log.debug(message, ...meta),
      info: (message: string, ...meta: unknown[]) => log.info(message, ...meta),
      warn: (message: string, ...meta: unknown[]) => log.warn(message, ...meta),
      error: (message: string, ...meta: unknown[]) => log.error(message, ...meta),
    },
    status(next: string): void {
      detail = next;
      registry.update(taskId, { detail: next });
    },
    sleep: (ms: number) => cancellableSleep(ms, signal),
    currentDetail: () => detail,
  };
}

function missingSnapshot(taskId: string, subroutine: Subroutine): TaskSnapshot {  return {
    id: taskId,
    kind: 'subroutine',
    name: subroutine.name,
    state: 'failed',
    createdAt: Date.now(),
  };
}

/** Trim and lowercase a subroutine name for lookup. */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Brand an internal prepared run as the opaque public type.
 *
 * The brand only exists to stop callers constructing or inspecting one; the
 * registry is the sole producer and consumer of the value behind it.
 */
function asPreparedRun(internal: InternalPreparedRun): PreparedRun {
  return internal as unknown as PreparedRun;
}

/**
 * Map positional arguments onto declared parameters.
 *
 * A parameter marked `rest` absorbs every remaining argument (joined by single
 * spaces), which is why `type-text hello world` works as well as the quoted
 * form. Throws on missing required parameters and on stray arguments, so a
 * mistake at the prompt is reported rather than silently ignored.
 */
export function resolveParams(
  subroutine: Subroutine,
  raw: readonly string[],
): Record<string, string> {
  const declared: readonly SubroutineParam[] = subroutine.params ?? [];
  const resolved: Record<string, string> = {};
  const restIndex = declared.findIndex((param) => param.rest === true);
  // Arguments past a rest parameter belong to it, not to a following parameter.
  const positionalEnd = restIndex === -1 ? declared.length : restIndex;

  for (const [index, param] of declared.entries()) {
    if (param.rest === true) {
      const joined = raw.slice(index).join(' ').trim();
      if (joined === '') {
        if (param.defaultValue !== undefined) resolved[param.name] = param.defaultValue;
        else if (param.required) {
          throw new Error(`"${subroutine.name}" needs ${param.name}: ${param.description}`);
        }
        continue;
      }
      resolved[param.name] = joined;
      continue;
    }
    if (index >= positionalEnd) continue;

    const rawValue = raw[index];
    if (rawValue === undefined || rawValue === '') {
      if (param.defaultValue !== undefined) {
        resolved[param.name] = param.defaultValue;
        continue;
      }
      if (param.required) {
        throw new Error(`"${subroutine.name}" needs ${param.name}: ${param.description}`);
      }
      continue;
    }
    resolved[param.name] = rawValue;
  }

  // A rest parameter absorbs everything after it by definition, so there can be
  // no such thing as a stray argument once one is declared.
  if (restIndex === -1) {
    const extras = raw.slice(declared.length).filter((value) => value !== '');
    if (extras.length > 0) {
      throw new Error(
        `"${subroutine.name}" accepts at most ${declared.length} argument(s); ` +
          `got ${raw.length} (unexpected: ${extras.join(', ')}).`,
      );
    }
  }

  return resolved;
}
