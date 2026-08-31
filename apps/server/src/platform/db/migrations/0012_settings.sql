-- app_setting: the restaurant's own configuration, the things that used
-- to be hard-coded into the print templates or fixed at deploy time in
-- the environment (restaurant name, receipt header/footer, printer
-- address).
--
-- One key/value table rather than a column-per-setting table: the set of
-- settings grows every time the restaurant wants one more line on its
-- receipt, and each addition would otherwise be a migration. The shape
-- of each value is enforced in code instead, by settings/schema.ts —
-- one Zod schema per group, so a malformed value can never reach a
-- print template.
--
-- `value_json` holds a JSON document per group (not per scalar) so one
-- admin save of "receipt settings" is one row write, and reading a group
-- back is one row read with no N+1.
CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user (id)
);
