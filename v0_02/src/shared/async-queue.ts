/**
 * A promise queue that runs one job at a time.
 *
 * Why this exists: with one terminal, commands arrive one at a time by
 * construction. With several terminals attached to one daemon, two clients can
 * issue commands in the same millisecond. Some of those combinations are
 * harmless (`list` and `status`), but `stop` racing a half-finished `list` makes
 * output interleave confusingly, and a command that reads state can see a
 * half-applied change.
 *
 * Serialising command *decisions* — not the work they start — is the cheap fix.
 * The queue only covers the short window in which a command is evaluated; a
 * subroutine it launches still runs in the background, so `stop` from another
 * client can still interrupt it.
 */

export type Job<T> = () => Promise<T> | T;

export class AsyncQueue {
  /** Tail of the chain. Each job waits for the previous one to settle. */
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;

  /** Number of jobs currently waiting (not counting the one running). */
  get pending(): number {
    return this.#queued;
  }

  /**
   * Run `job` after everything queued before it.
   *
   * Rejections propagate to *this* caller only; the chain itself always
   * continues, so one failing command cannot wedge the queue forever.
   */
  run<T>(job: Job<T>): Promise<T> {
    this.#queued += 1;
    const result = this.#tail.then(async () => {
      this.#queued -= 1;
      return job();
    });
    // Keep the chain alive on failure. `catch` returns undefined, so a later job
    // never inherits the previous error.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
