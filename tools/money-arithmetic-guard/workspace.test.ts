import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanWorkspace } from './scan-workspace.js';

const workspaceRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('money-arithmetic guard (workspace gate)', () => {
  it('finds no bare * or / on a Paisa value outside platform/money', () => {
    const violations = scanWorkspace(workspaceRoot);
    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${path.relative(workspaceRoot, v.file)}:${v.line}:${v.column} — ${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} bare Paisa arithmetic violation(s) outside platform/money:\n${details}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
