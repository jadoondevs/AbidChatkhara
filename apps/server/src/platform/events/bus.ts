import type { DomainEventMap } from './types.js';

type Handler<T> = (payload: T) => void;

/**
 * An in-process, synchronous publish/subscribe bus for domain events.
 *
 * Synchronous and in-process because this is a single-writer server: an
 * event handler runs to completion, in subscription order, on the same
 * call stack as `emit`. There is no queueing, no retry, and no delivery
 * guarantee across a restart — that is what `platform/sync-queue` is for
 * (tasks that must survive a crash or need retrying enqueue there
 * instead). This bus is for same-process fan-out only: today, nothing
 * subscribes; inventory and staff-management will, later, without any
 * change to the modules that emit.
 *
 * Callers must `emit` only after the write transaction that produced the
 * event has committed, so every subscriber sees already-durable state.
 */
export class EventBus {
  private readonly handlers = new Map<keyof DomainEventMap, Handler<never>[]>();

  on<K extends keyof DomainEventMap>(event: K, handler: Handler<DomainEventMap[K]>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(event, list);
  }

  /**
   * A subscriber that throws is caught and logged, never rethrown to the
   * caller of `emit`: the write already committed, so a broken subscriber
   * must not make it look like the write failed, and must not stop other
   * subscribers of the same event from running.
   */
  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      try {
        handler(payload as never);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[event-bus] subscriber to "${String(event)}" threw`, err);
      }
    }
  }
}

/** The process-wide event bus. */
export const eventBus = new EventBus();
