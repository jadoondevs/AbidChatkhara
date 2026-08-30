export type Role = 'server' | 'cashier' | 'manager' | 'admin';

export const ROLES: readonly Role[] = ['server', 'cashier', 'manager', 'admin'];

/**
 * Roles are ranked so call sites can ask "at least manager" without
 * hard-coding which specific roles qualify — e.g. an admin can do
 * everything a manager can. Where the spec instead names an exact,
 * non-hierarchical actor (e.g. "the cashier enters the service charge"),
 * check the role directly rather than with this helper.
 */
const RANK: Record<Role, number> = { server: 0, cashier: 1, manager: 2, admin: 3 };

export function hasAtLeastRole(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}
