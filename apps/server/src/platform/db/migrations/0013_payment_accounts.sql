-- payment_account: the individual Easypaisa wallets and bank accounts a
-- payment can actually land in.
--
-- payment_method already carries a single account_title/account_number
-- (billing milestone), which is enough to PRINT one set of payment
-- instructions on a bill but cannot answer "which of our three accounts
-- received this transfer?" — a real restaurant runs more than one, and
-- the partner/reconciliation reports need to tell them apart. So the
-- account becomes its own row, and a payment references the one it
-- landed in.
--
-- payment_method's own account_* columns are left in place and still
-- print: they are the "pay us here" line on a pro-forma bill, which is
-- about advertising an account, not recording which one was used. An
-- account row is the record of receipt.
CREATE TABLE payment_account (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method_id INTEGER NOT NULL REFERENCES payment_method (id),
  label             TEXT NOT NULL,
  account_title     TEXT,
  account_number    TEXT,
  bank_name         TEXT,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_payment_account_method ON payment_account (payment_method_id);

-- Which account received this payment. Nullable: cash has no account,
-- and every payment already recorded predates this table.
ALTER TABLE payment ADD COLUMN payment_account_id INTEGER REFERENCES payment_account (id);

-- What the customer physically handed over, and what was handed back.
--
-- amount_minor stays what it has always been: the amount APPLIED to the
-- bill, which is what sales, allocations and expected cash are all
-- computed from. Change is not a discount and not a refund — the drawer
-- nets out to amount_minor either way — so these two columns exist for
-- the audit trail and the Z-report's "cash handled" line, and nothing
-- financial is derived from them.
--
-- Both are NULL for a non-cash payment and for every payment recorded
-- before this migration.
ALTER TABLE payment ADD COLUMN tendered_minor INTEGER;
ALTER TABLE payment ADD COLUMN change_minor INTEGER;
