-- Login credentials: a username to sign in with, alongside the secret
-- hash `user.pin_hash` already holds.
--
-- The UX this supports is a normal PC login form (username + password),
-- not a tablet PIN pad, so the stored secret is no longer necessarily a
-- PIN. The COLUMN keeps its name rather than being renamed: it has
-- always held a salted scrypt hash of whatever the user types, and
-- renaming it would rewrite every already-deployed database's schema
-- for a cosmetic gain. identity/credentials.ts is the code-side name
-- for what it actually stores.
--
-- Existing users must keep working, so `username` is backfilled from
-- the first word of each name (the natural thing an operator would have
-- typed anyway) rather than left NULL for an admin to fill in by hand
-- before anyone can log in again.
ALTER TABLE user ADD COLUMN username TEXT;

-- A snapshot of the derived base names, so the de-duplication pass
-- below reads a frozen table rather than rows it is itself updating.
CREATE TEMPORARY TABLE username_seed AS
SELECT
  id,
  lower(
    replace(replace(replace(replace(replace(
      CASE WHEN instr(name, ' ') > 0 THEN substr(name, 1, instr(name, ' ') - 1) ELSE name END,
    '.', ''), '''', ''), '-', ''), '_', ''), '"', '')
  ) AS base
FROM user;

-- One user per base name keeps the plain name; a collision gets
-- `name.id`, which cannot itself collide with another derived base
-- (the '.' is stripped out of every base above).
UPDATE user
SET username = (
  SELECT CASE
    WHEN s.base = '' THEN 'user' || user.id
    WHEN (SELECT COUNT(*) FROM username_seed AS other WHERE other.base = s.base) > 1 THEN s.base || '.' || user.id
    ELSE s.base
  END
  FROM username_seed AS s
  WHERE s.id = user.id
);

DROP TABLE username_seed;

CREATE UNIQUE INDEX idx_user_username ON user (username);
