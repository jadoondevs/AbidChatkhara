-- Who the order is for, and what the kitchen was told about a line.
--
-- Two things a restaurant records on paper every day that this schema
-- had nowhere to put:
--
--   * The customer. A delivery order without a name and a phone number
--     cannot be delivered, and a takeaway that has to be called for
--     collection needs the same. Dine-in usually has neither, so both
--     columns are optional on every order type rather than required on
--     some.
--
--   * The line note. "No onions", "well done", "pack separately" — the
--     instruction belongs to the line it was said about, and it has to
--     survive onto the historical record: a customer disputing what
--     they were given is asking exactly what was written here.
--
-- All three are free text and nullable. Nothing existing needs a
-- backfill: an order taken before today genuinely had no customer
-- recorded, and inventing one would be a worse answer than NULL.
ALTER TABLE "order" ADD COLUMN customer_name TEXT;
ALTER TABLE "order" ADD COLUMN customer_phone TEXT;
ALTER TABLE order_line ADD COLUMN note TEXT;
