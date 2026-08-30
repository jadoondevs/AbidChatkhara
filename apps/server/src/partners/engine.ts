import { splitByShares, sum, type Paisa } from '@pos/shared';

/**
 * The pure partner allocation engine. No database, no I/O — a function
 * of its inputs only, so it can be (and is) property-tested exhaustively
 * without standing up a database. See ARCHITECTURE.md and
 * docs/decisions/002-largest-remainder-allocation.md for why this
 * matters more here than almost anywhere else in the system: this is
 * the code that decides how much of a real sale a real partner is owed.
 *
 * Algorithm (matches the spec's allocation-engine pseudocode exactly —
 * this is a thin, labelled wrapper around the money module's
 * `splitByShares`, which already implements steps 2-6 as
 * largest-remainder distribution in bigint):
 *
 *   1. (caller's job — see partners/service.ts) look up active ownership
 *      for the item/modifier as of the order's close time.
 *   2-5. exact_i = base * share_bp_i / 10000, floored, remainder
 *      distributed one paisa at a time to the largest fractional parts,
 *      ties broken by partner_id ascending (shares must be passed
 *      pre-sorted by partner_id for this to hold).
 *   6. `splitByShares` asserts its own output sums to exactly the base
 *      and throws rather than returning a partial result if it doesn't
 *      — "never write a partial allocation" is enforced by construction,
 *      not re-checked here as an afterthought.
 */

/**
 * At launch, allocations are always based on net sales excluding tax
 * (the spec's `NET_SALES_EX_TAX`). This engine doesn't compute the
 * base — the caller does (ordering already snapshots
 * `allocation_base_minor` = net sales onto every line and separately-
 * owned modifier) — it only labels each output row with which mode
 * produced the base it was given. A future cost-based mode (once
 * inventory exists) is a caller computing a different base and passing
 * a different mode label here; nothing in this engine, or in the shape
 * of a `line_allocation` row, has to change.
 */
export type AllocationBaseMode = 'NET_SALES_EX_TAX';

export interface OwnershipShare {
  readonly partnerId: number;
  readonly shareBp: number;
}

export interface AllocationTarget {
  /** Identifies what's being allocated — the order_line_id or
   * order_line_modifier_id this allocation is for, as a string. Opaque
   * to this engine; threaded through to the output unchanged. */
  readonly key: string;
  readonly allocationBaseMinor: Paisa;
  /** Must be pre-sorted by partnerId ascending, and (if non-empty) sum
   * to exactly 10000 basis points — both enforced by `splitByShares`. */
  readonly shares: readonly OwnershipShare[];
  readonly allocationBaseMode: AllocationBaseMode;
}

export interface AllocatedAmount {
  readonly key: string;
  readonly partnerId: number;
  readonly shareBpSnapshot: number;
  readonly amountMinor: Paisa;
  readonly allocationBaseMode: AllocationBaseMode;
}

/**
 * Allocate one target's base across its ownership shares. Returns one
 * `AllocatedAmount` per share; empty if `shares` is empty (nothing owns
 * this yet — only valid when the base is also zero, exactly as
 * `splitByShares` requires).
 */
export function allocateOne(target: AllocationTarget): AllocatedAmount[] {
  const parts = splitByShares(
    target.allocationBaseMinor,
    target.shares.map((s) => ({ key: String(s.partnerId), shareBp: s.shareBp })),
  );

  const result = target.shares.map((share, i) => ({
    key: target.key,
    partnerId: share.partnerId,
    shareBpSnapshot: share.shareBp,
    amountMinor: parts[i] as Paisa,
    allocationBaseMode: target.allocationBaseMode,
  }));

  // Defense in depth, per the spec's explicit requirement: re-assert the
  // sum here too, even though splitByShares already guarantees it by
  // construction — never let a partial allocation reach a caller that
  // might write it to the ledger.
  const total = sum(result.map((r) => r.amountMinor));
  if (total !== target.allocationBaseMinor) {
    throw new Error(
      `allocateOne: allocated ${total} but base was ${target.allocationBaseMinor} for target "${target.key}" — refusing to return a partial allocation`,
    );
  }

  return result;
}

/** Allocate every target in one order (or any batch), in target order. */
export function allocateAll(targets: readonly AllocationTarget[]): AllocatedAmount[] {
  return targets.flatMap(allocateOne);
}
