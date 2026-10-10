-- purchases/: mark WHICH paid-from source is the actual cash drawer, so
-- "remaining in drawer" can subtract only the purchases taken from the
-- till — not ones a person (e.g. Irfan) paid out of pocket. A source's
-- name ("Cash drawer") is just a label; this flag is the unambiguous
-- signal. At most one source is the drawer (enforced in the service).
--
-- Purely for a view-only figure: it still moves no money and changes no
-- balance. Defaults off, so until the owner ticks it, drawer purchases
-- count as zero and the remaining equals the expected cash.
ALTER TABLE purchase_source ADD COLUMN is_cash_drawer INTEGER NOT NULL DEFAULT 0 CHECK (is_cash_drawer IN (0, 1));
