/**
 * A tiny publish/subscribe bus.
 *
 * Introduced in v0_02. In v0_01 the terminal reached into the task registry and
 * installed an observer directly; that works when there is exactly one
 * interested party in exactly one process. Once several clients must see the
 * same progress, "who is watching?" becomes a list, and a bus is the smallest
 * thing that expresses it.
 *
 * Deliberately synchronous and dependency-free: publishing must never throw, and
 * a slow subscriber must not be able to stall the work being reported on.
 */

export type EventListener<T> = (event: T) => void;

export class EventBus<T> {
  readonly #listeners = new Set<EventListener<T>>();

  /** Subscribe; the returned function unsubscribes. */
  subscribe(listener: EventListener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Publish to every subscriber.
   *
   * Each listener is isolated: one throwing subscriber cannot stop the others
   * from being notified, and cannot break the code that published.
   */
  publish(event: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Intentionally ignored. A logging subscriber that throws must not take
        // down the process that was merely reporting something.
      }
    }
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
