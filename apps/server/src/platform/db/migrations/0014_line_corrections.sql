-- Distinguishes the two things that both currently set order_line.voided:
--
--   'correction' — the cashier mis-tapped an item onto an order that has
--                  never been billed. Nothing has been printed, nothing
--                  has been shown to a customer. Any signed-in user may
--                  do this, and it is not evidence of anything.
--   'void'       — the line existed on a bill that was already finalised
--                  (order.billed_at is set, even if it has since been
--                  reopened). This needs manager approval, a reason, and
--                  is what the theft-control report is actually about.
--
-- The row is still never deleted in either case: `voided` stays the flag
-- the money pipeline reads, and both kinds are in the audit log. This
-- column only records WHICH of the two happened, so the void report can
-- stop treating a mis-tap as a suspicious void.
--
-- Existing voided rows are all 'void': every one of them was written by
-- the manager-approved path, which was the only path that existed.
ALTER TABLE order_line ADD COLUMN void_kind TEXT CHECK (void_kind IN ('correction', 'void'));

UPDATE order_line SET void_kind = 'void' WHERE voided = 1;

-- "Has this order ever been billed?", which `billed_at` cannot answer:
-- reopening an order clears billed_at (that is what makes it open
-- again), so after a reopen an order that has been printed and handed
-- to a customer looks exactly like one that never left the kitchen.
--
-- This column is set the first time an order is billed and never
-- cleared, so the correction-vs-void rule above stays true across a
-- reopen — and so does addLine's "merge a repeat tap into the existing
-- line" rule, which must stop the moment a customer has seen a printed
-- line.
ALTER TABLE "order" ADD COLUMN first_billed_at TEXT;

UPDATE "order" SET first_billed_at = COALESCE(billed_at, closed_at)
WHERE billed_at IS NOT NULL OR closed_at IS NOT NULL;
