-- When a payment account was last edited.
--
-- `created_at` alone cannot answer "was this account number changed
-- after payments started landing in it?", which is the first question
-- asked when a transfer turns out to have gone somewhere unexpected.
--
-- Backfilled to created_at rather than to "now": an account nobody has
-- edited was last changed when it was created, and stamping the
-- migration's own timestamp would claim an edit that never happened.
ALTER TABLE payment_account ADD COLUMN updated_at TEXT;

UPDATE payment_account SET updated_at = created_at WHERE updated_at IS NULL;
