/**
 * The map of every domain event this system can publish, keyed by event
 * name. It starts empty on purpose: `platform/events` knows nothing about
 * `ordering` or `billing`'s data shapes — each module that publishes an
 * event augments this interface via TypeScript declaration merging where
 * it defines the event, e.g.
 *
 *   declare module '../../platform/events/types.js' {
 *     interface DomainEventMap {
 *       OrderClosed: { orderId: number; invoiceNo: number; closedAt: string, ... };
 *     }
 *   }
 *
 * so the event bus stays fully typed (`eventBus.on('OrderClosed', ...)`
 * gets the right payload type) without platform/ ever importing a domain
 * module. Milestones that emit `OrderClosed`, `OrderVoided`,
 * `RefundIssued`, `PaymentRecorded`, and `ShiftClosed` each add their
 * entry here as they're built.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEventMap {}
