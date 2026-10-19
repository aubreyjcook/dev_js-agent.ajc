/**
 * The subroutine contract.
 *
 * A *subroutine* is one self-contained, user-invokable behaviour — "type this
 * text", "open a URL", "drag from here to there". Subroutines live in their own
 * folder, one file per behaviour, and are registered in a registry so the
 * terminal can list and run them.
 *
 * Rules a subroutine must follow — they are what keep the two halves separable:
 *
 *  1. Only talk to the outside world through {@link SubroutineContext.agent}.
 *  2. Never import from `src/core`. Types come from `src/contract`.
 *  3. Call `ctx.signal.throwIfCancelled()` between every step, so `stop` works.
 *  4. Never call `process.exit`, never drive the terminal, never log directly to
 *     stdout — use `ctx.log` and `ctx.status`.
 */

import type { AgentApi } from './agent-api.js';
import type { CancellationSignal } from './signals.js';
import type { TaskSnapshot } from './tasks.js';

/** A declared input, so the terminal can show and validate usage. */
export interface SubroutineParam {
  name: string;
  required: boolean;
  /** Shown in `help`. */
  description: string;
  /** Used when the parameter is omitted. */
  defaultValue?: string;
  /**
   * When true this parameter soaks up every remaining argument, joined by
   * spaces. Declare it last.
   *
   * It exists so that `type-text hello world` does what a person expects instead
   * of failing on a stray "world"; quoting is still supported and still exact.
   */
  rest?: boolean;
}

/** Everything a subroutine may use while it runs. */
export interface SubroutineContext {
  /** Handle on the agent — the only route to real input. */
  readonly agent: AgentApi;
  /** Cancellation for this run; check it between steps. */
  readonly signal: CancellationSignal;
  /** Positional parameters, parsed from the terminal command line. */
  readonly params: Readonly<Record<string, string>>;
  /** Convenience accessor: required, trimmed parameter value. */
  param(name: string): string;
  /** Convenience accessor: parameter value, or `fallback`. */
  paramOr(name: string, fallback: string): string;
  /** Reports under `sub:<name>`. */
  readonly log: {
    debug(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
  };
  /** Publish short progress text, visible via the terminal's `list` command. */
  status(detail: string): void;
  /** Cancellable pause — the only sleep a subroutine should use. */
  sleep(ms: number): Promise<void>;
}

/** One invokable behaviour. */
export interface Subroutine {
  /** Terminal command name. Lowercase, kebab-case, unique. */
  readonly name: string;
  /** One-line summary for `help`. */
  readonly summary: string;
  /** Longer description for `help <name>`. */
  readonly description?: string;
  /** Declared parameters, in positional order. */
  readonly params?: readonly SubroutineParam[];
  /** Perform the behaviour. Resolve on success; throw on failure. */
  readonly entry: (ctx: SubroutineContext) => Promise<void>;
}

/** Why a run ended. */
export type SubroutineOutcome = 'completed' | 'failed' | 'cancelled';

/** Result of a run, whatever the outcome. Never throws. */
export interface SubroutineRunResult {
  outcome: SubroutineOutcome;
  task: TaskSnapshot;
  /** Populated when `outcome` is `failed`. */
  error?: Error;
}

/**
 * A run that has been validated and is ready to start.
 *
 * Opaque by design: it is produced by {@link SubroutineApi.prepareRun} and only
 * {@link SubroutineApi.run} understands it. The type exists so callers can hold
 * one without knowing its shape.
 */
export interface PreparedRun {
  readonly [preparedRunBrand]: true;
}

declare const preparedRunBrand: unique symbol;

/** Outcome of validating a run before any work starts. */
export type PrepareRunResult =
  | { ok: true; run: PreparedRun }
  | { ok: false; reason: 'unknown' | 'busy' | 'invalid'; message: string };

/** What the terminal layer is given to work with. */
export interface SubroutineApi {
  /** All registered subroutines, in registration order. */
  list(): readonly Subroutine[];
  /** Look one up by terminal name, including aliases. */
  get(name: string): Subroutine | undefined;
  /**
   * Validate a run *synchronously*: name known, arguments well formed, nothing
   * with the same name already running.
   *
   * This exists so the terminal can report a mistake at the prompt. Validation
   * inside an `async` method would surface asynchronously, which means a caller
   * would have to choose between blocking on the whole run and never learning
   * that the invocation was bad.
   */
  prepareRun(name: string, rawParams: readonly string[]): PrepareRunResult;
  /** Start a prepared run in the background and settle when it ends. */
  run(name: string, rawParams: readonly string[], options?: { quiet?: boolean }): Promise<SubroutineRunResult>;
  /** Start a run that {@link prepareRun} already validated. */
  start(prepared: PreparedRun, options?: { quiet?: boolean }): Promise<SubroutineRunResult>;
  /** Snapshot of the subroutines that are still pending or running. */
  active(): readonly TaskSnapshot[];
  /** Finished runs, most recently finished first. */
  recent(filter?: { since?: number }): readonly TaskSnapshot[];
  /** Cancel every active subroutine run and wait for them to settle. */
  stopAll(reason?: string): Promise<readonly TaskSnapshot[]>;
}
