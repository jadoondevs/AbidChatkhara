# 15. People and login accounts stay separate

## Context

The People screen manages `person` rows — staff and partners whose meals
the restaurant tracks, each with a meal policy. Login accounts are
`user` rows, with a role and now a username and password. There is no
link between them.

The obvious-looking simplification is to merge the two: one "staff"
record with both a meal policy and a password. It was considered and
rejected.

## Decision

They stay separate tables, separate screens, and separate concepts.
People are configured on the People screen; login accounts under
Settings → Users. Each screen says what it is and links to the other.

## Why

**Most people in each set are not in the other.** A cook whose free
meals the restaurant tracks never touches the till and must not have a
password. A partner who eats here is not an employee at all. Conversely
a terminal user has a role and a credential and no meal policy — giving
them one would mean every login account carried a "free / discounted /
payroll deduction" field that is meaningless for almost all of them.

**They have different lifetimes and different reasons to change.** A
person's meal policy is snapshotted onto every meal at settlement
(docs/decisions/009) precisely so changing it never rewrites history. A
user's password changes because it leaked, their role changes because
they were promoted, and their account is deactivated the day they leave.
Merging would put an audit-sensitive credential and a
historically-snapshotted policy in one row with one set of update paths.

**Attribution already works, and does not need a link.** A `person` is
who a meal was *for*; a `user` is who *did* something. `order.opened_by`,
`void_approved_by` and every `audit_log` row reference a user;
`order.beneficiary_person_id` references a person. Nothing in the system
needs to ask "which user is this person", and adding a join would invite
code that assumes the answer always exists.

**Nothing stops a restaurant having both** for the same human — a waiter
who signs in and whose meals are tracked is a `user` and a `person`,
created independently. That is a data-entry cost of two records for one
person, which is the price of not forcing the other thousand cases into
a shape that does not fit them.

## Consequences

- Deactivating a login account does not stop tracking that person's
  meals, and vice versa. Both are deliberate.
- The two screens cross-link, so an admin looking for the wrong one is
  one click from the right one rather than confused about why a cook has
  no password field.
- If a future requirement genuinely needs the link (say, "staff can see
  their own meal balance"), it is a nullable `user_id` on `person` —
  additive, and still not a merge.
