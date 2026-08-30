-- tax/: configurable tax rules, shipped with none active — "no active
-- rules" (spec) means order.tax_minor is zero on every order until a
-- manager configures one, and turning tax on later must be a config
-- change here, never a code change. See docs/decisions/010 for how
-- `inclusive` is applied.
--
-- applies_to_category_id/applies_to_order_type are both nullable —
-- null means "every category" / "every order type" respectively, not
-- "applies to nothing".
CREATE TABLE tax_rule (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  rate_bp                 INTEGER NOT NULL CHECK (rate_bp >= 0),
  applies_to_category_id  INTEGER REFERENCES category (id),
  applies_to_order_type   TEXT CHECK (applies_to_order_type IN ('dine_in', 'takeaway', 'delivery')),
  inclusive               INTEGER NOT NULL DEFAULT 0 CHECK (inclusive IN (0, 1)),
  valid_from              TEXT NOT NULL,
  valid_to                TEXT,
  active                  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX idx_tax_rule_category ON tax_rule (applies_to_category_id);
