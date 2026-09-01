-- Two things a payment has to answer for itself, months later.
--
-- 1. WHETHER AN ACCOUNT'S DETAILS PRINT.
--
-- "Which accounts can take money" and "which accounts get printed for
-- the customer to send money to" are different questions, and they were
-- answered by the same flag on the wrong table: `payment_method
-- .print_on_bill`, which is per METHOD, so a restaurant with two
-- Easypaisa wallets could not print one and keep the other off the
-- ticket. It also meant hiding an account from a bill required
-- deactivating it, which stops the cashier taking payments into it.
--
-- The flag belongs on the account. It is independent of `active`: an
-- account can be live and unprinted, which is exactly the case that had
-- no representation before.
--
-- Backfilled from the method's old flag, so every existing install
-- prints precisely what it printed yesterday.
ALTER TABLE payment_account ADD COLUMN print_on_receipt INTEGER NOT NULL DEFAULT 1 CHECK (print_on_receipt IN (0, 1));

UPDATE payment_account
SET print_on_receipt = COALESCE(
  (SELECT payment_method.print_on_bill FROM payment_method WHERE payment_method.id = payment_account.payment_method_id),
  1
);

-- 2. WHERE THE MONEY ACTUALLY WENT.
--
-- `payment` referenced the account by id, so a receipt reprinted after
-- someone corrected the account holder's name showed the NEW name over
-- an OLD transaction — the account details on the reprint were a live
-- query, not a record. Same for the method's display name.
--
-- These columns are the record. `payment_account_id` stays: it is the
-- link, and reports that group by account still need it. What is
-- printed and shown comes from here (see docs/decisions/020 — the same
-- rule the item name already follows).
--
-- The print preference is snapshotted too: a reprint has to reproduce
-- the ticket that was handed over, and changing the setting affects the
-- receipts printed after it, which is what "future receipts" means.
ALTER TABLE payment ADD COLUMN method_name_snapshot TEXT;
ALTER TABLE payment ADD COLUMN account_label_snapshot TEXT;
ALTER TABLE payment ADD COLUMN account_number_snapshot TEXT;
ALTER TABLE payment ADD COLUMN account_bank_snapshot TEXT;
ALTER TABLE payment ADD COLUMN account_print_on_receipt_snapshot INTEGER;

-- Backfilled from what each payment currently points at. For rows
-- written before this migration that IS the best available answer, and
-- it is the same answer the live lookup was giving a moment ago.
UPDATE payment
SET method_name_snapshot = (SELECT display_name FROM payment_method WHERE payment_method.id = payment.payment_method_id)
WHERE method_name_snapshot IS NULL;

UPDATE payment
SET
  account_label_snapshot = (SELECT label FROM payment_account WHERE payment_account.id = payment.payment_account_id),
  account_number_snapshot = (SELECT account_number FROM payment_account WHERE payment_account.id = payment.payment_account_id),
  account_bank_snapshot = (SELECT bank_name FROM payment_account WHERE payment_account.id = payment.payment_account_id),
  account_print_on_receipt_snapshot = (SELECT print_on_receipt FROM payment_account WHERE payment_account.id = payment.payment_account_id)
WHERE payment_account_id IS NOT NULL;
