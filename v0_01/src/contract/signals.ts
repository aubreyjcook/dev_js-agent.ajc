/**
 * Cooperative cancellation.
 *
 * Anything long-running in this program must accept a {@link CancellationSignal}
 * and check it between steps. That is what makes the terminal's `stop` command
 * able to interrupt a subroutine that is halfway through typing.
 */

/** Raised when an operation notices it has been cancelled. */
export class OperationCancelledError extends Error {
  readonly kind = 'cancelled';

  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

/** Thrown by {@link CancellationSignal.throwIfCancelled}. */
export class CancelledError extends OperationCancelledError {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** Read-only view of a cancellation source, handed to the code being cancelled. */
export interface CancellationSignal {
  readonly isCancelled: boolean;
  /**
   * Throw a {@link CancelledError} if cancellation has been requested.
   * Call this between every meaningful step.
   */
  throwIfCancelled(): void;
  /** Run `listener` once, when cancellation is requested. */
  onCancel(listener: () => void): void;
  /** Undo an {@link onCancel} registration. */
  offCancel(listener: () => void): void;
}

/** The writable side of a cancellation source. */
export interface CancellationController {
  readonly signal: CancellationSignal;
  cancel(reason?: string): void;
}

/** Injectable delay, so tests can run without real time passing. */
export type SleepClock = (ms: number) => Promise<void>;

export const realSleep: SleepClock = (ms) =>
  new Promise<void>((resolve) => {
    // Deliberately *not* unref'd. A pending delay means the program is waiting
    // for something it asked to happen; letting the loop drain would abandon it
    // mid-action. Cancellation, not loop-exit, is how a wait gets cut short.
    setTimeout(resolve, ms);
  });

/**
 * Sleep, but settle as soon as the signal is cancelled.
 *
 * The listeners are always removed and the promise always settles exactly once,
 * whichever happens first — cancellation, expiry, or a clock that throws. An
 * earlier version left this promise pending when the signal was already
 * cancelled, which hung `stop`.
 */
export function cancellableSleep(
  ms: number,
  signal: CancellationSignal,
  clock: SleepClock = realSleep,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.offCancel(onCancel);
      return true;
    };

    function onCancel(): void {
      if (finish()) reject(new CancelledError('Interrupted while waiting'));
    }

    // Skip the wait entirely when the delay is meaningless, but still report an
    // already-cancelled signal.
    if (ms <= 0) {
      finish();
      if (signal.isCancelled) reject(new CancelledError('Cancelled before waiting'));
      else resolve();
      return;
    }

    if (signal.isCancelled) {
      finish();
      reject(new CancelledError('Cancelled before waiting'));
      return;
    }

    signal.onCancel(onCancel);
    clock(ms).then(
      () => {
        if (finish()) resolve();
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
}

/**
 * Default {@link CancellationController} implementation.
 *
 * Deliberately independent of `AbortController`, so the same mechanism works for
 * both halves of the program and stays trivially testable.
 */
export class CancelToken implements CancellationController {
  #cancelled = false;
  #reason: string | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #signal: CancellationSignal;

  constructor() {
    this.#signal = {
      isCancelled: false,
      throwIfCancelled: () => {
        if (this.#cancelled) {
          throw new CancelledError(this.#reason ?? 'Cancelled');
        }
      },
      onCancel: (listener: () => void) => {
        if (this.#cancelled) {
          listener();
          return;
        }
        this.#listeners.add(listener);
      },
      offCancel: (listener: () => void) => {
        this.#listeners.delete(listener);
      },
    };
    Object.defineProperty(this.#signal, 'isCancelled', {
      get: () => this.#cancelled,
      enumerable: true,
    });
  }

  get signal(): CancellationSignal {
    return this.#signal;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  cancel(reason?: string): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#reason = reason;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A failing listener must not prevent the remaining ones from running.
      }
    }
  }
}
