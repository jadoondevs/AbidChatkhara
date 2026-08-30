# 11. An order's `shift_id` is best-effort, not required

## Context

`order.shift_id` and `service_charge_entry.shift_id` are the deferred
columns migrations 0004 and 0007 promised, filled in now that `shift`
rows exist. The obvious, strict design would make an open shift a hard
prerequisite for `createOrder` — no shift open, no order — which is
also how a real restaurant actually operates (you open the till before
you take an order). But `createOrder` is called from the fixtures of
essentially every other module's test suite (catalog, ordering itself,
partners, billing, gratuity, consumption, tax), none of which are about
shifts and none of which should need to know shifts exist to set up an
order for their own, unrelated test.

## Decision

`createOrder` tags a new order with whichever shift is currently open,
if any (`select * from shift where closed_at is null`) — it does not
require one to exist. An order created while no shift is open simply
carries `shift_id: null`, and proceeds exactly as it always has.

This keeps the column's *real* invariant intact for actual operation
(a restaurant that opens a shift each morning before taking orders,
which is the only sane way to run a till) while costing nothing in
every other module's tests, none of which call `openShift` and all of
which keep working unchanged. The alternative — making every one of
those fixtures open a shift first — would be a purely mechanical,
low-value change spread across the whole codebase for a rule that
production usage already satisfies on its own.

## Consequences

- `shifts.closeShift`'s "refuse to close while any order is still open
  or awaiting payment" check is scoped to `order.shift_id = :shiftId`,
  not global — correct given the above, since in real operation every
  order gets a real shift_id and no order can belong to two shifts at
  once (only one shift is ever open).
- An order opened before any shift ever existed (`shift_id: null`) is
  invisible to any shift's close-blocking check and to
  `getZReport`/`waiterPayoutTotals`'s shift scoping. This is a real,
  narrow gap — not a bug: it only affects orders taken during a window
  with no shift open at all, which a seed script (opening the first
  shift immediately) and ordinary daily operation both avoid in
  practice. A frontend milestone can close it entirely by making "open
  a shift" the first screen after login, refusing to reach the floor
  view otherwise.
- `gratuity`'s `service_charge_entry.shift_id` follows the same
  best-effort rule, copied from `order.shift_id` at the moment the entry
  is written (not required either) — and a reversal always carries the
  *original* entry's `shift_id`, never whatever shift happens to be open
  when the reversal itself is recorded, so a refund processed on a
  later shift correctly nets against the shift the original charge
  belonged to, not the one open at refund time.
