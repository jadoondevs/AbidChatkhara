import { describe, expect, it } from 'vitest';
import { hasAtLeastRole, ROLES } from './roles.js';

describe('hasAtLeastRole', () => {
  it('admin satisfies every minimum', () => {
    for (const minimum of ROLES) {
      expect(hasAtLeastRole('admin', minimum)).toBe(true);
    }
  });

  it('server only satisfies the server minimum', () => {
    expect(hasAtLeastRole('server', 'server')).toBe(true);
    expect(hasAtLeastRole('server', 'cashier')).toBe(false);
    expect(hasAtLeastRole('server', 'manager')).toBe(false);
    expect(hasAtLeastRole('server', 'admin')).toBe(false);
  });

  it('manager satisfies manager and below but not admin', () => {
    expect(hasAtLeastRole('manager', 'server')).toBe(true);
    expect(hasAtLeastRole('manager', 'cashier')).toBe(true);
    expect(hasAtLeastRole('manager', 'manager')).toBe(true);
    expect(hasAtLeastRole('manager', 'admin')).toBe(false);
  });
});
