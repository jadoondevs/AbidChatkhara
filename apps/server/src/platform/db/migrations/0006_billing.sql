-- billing/: payment methods, payments, and the invoice-number counter.

CREATE TABLE payment_method (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('cash', 'wallet', 'bank_transfer', 'card')),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  print_on_bill     INTEGER NOT NULL DEFAULT 0 CHECK (print_on_bill IN (0, 1)),
  account_title     TEXT,
  account_number    TEXT,
  bank_name         TEXT,
  instructions_line TEXT
);

-- Append-only, like every other financial table. A refund is a new
-- payment row with a negative amount_minor, referenced back to the
-- payment it reverses via reversed_by_payment_id on the ORIGINAL row.
CREATE TABLE payment (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id               INTEGER NOT NULL REFERENCES "order" (id),
  payment_method_id      INTEGER NOT NULL REFERENCES payment_method (id),
  amount_minor           INTEGER NOT NULL,
  reference_no           TEXT,
  received_by            INTEGER NOT NULL REFERENCES user (id),
  received_at            TEXT NOT NULL,
  reversed_by_payment_id INTEGER REFERENCES payment (id)
);

CREATE INDEX idx_payment_order ON payment (order_id);

-- A single-row counter, incremented with UPDATE ... RETURNING inside the
-- closing transaction — see docs/decisions/007. Never read without also
-- incrementing in the same transaction; that's the whole mechanism that
-- keeps invoice numbers gap-free and collision-free under concurrency.
CREATE TABLE invoice_counter (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  next_value INTEGER NOT NULL
);

INSERT INTO invoice_counter (id, next_value) VALUES (1, 1);
