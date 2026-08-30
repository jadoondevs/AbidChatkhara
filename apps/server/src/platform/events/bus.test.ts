import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus.js';

// Augment the event map for this test only, the same way a real domain
// module (ordering, billing, ...) would when it defines an event.
declare module './types.js' {
  interface DomainEventMap {
    TestEvent: { value: number };
    OtherEvent: { label: string };
  }
}

describe('EventBus', () => {
  it('delivers a payload to every subscriber, in subscription order', () => {
    const bus = new EventBus();
    const calls: number[] = [];
    bus.on('TestEvent', (p) => calls.push(p.value + 1));
    bus.on('TestEvent', (p) => calls.push(p.value + 2));

    bus.emit('TestEvent', { value: 10 });

    expect(calls).toEqual([11, 12]);
  });

  it('only delivers to subscribers of the matching event name', () => {
    const bus = new EventBus();
    const testHandler = vi.fn();
    const otherHandler = vi.fn();
    bus.on('TestEvent', testHandler);
    bus.on('OtherEvent', otherHandler);

    bus.emit('TestEvent', { value: 1 });

    expect(testHandler).toHaveBeenCalledOnce();
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it('emitting with no subscribers is a no-op, not an error', () => {
    const bus = new EventBus();
    expect(() => bus.emit('TestEvent', { value: 1 })).not.toThrow();
  });

  it('a throwing subscriber does not stop later subscribers or propagate to emit', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on('TestEvent', () => {
      calls.push('first');
      throw new Error('boom');
    });
    bus.on('TestEvent', () => calls.push('second'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => bus.emit('TestEvent', { value: 1 })).not.toThrow();
    errorSpy.mockRestore();

    expect(calls).toEqual(['first', 'second']);
  });
});
