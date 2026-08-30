import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgramForFiles, findViolations } from './checker.js';

// A self-contained stand-in for the real packages/shared/src/money/paisa.ts,
// so these tests exercise the detector's logic in isolation from the real
// workspace layout.
const PAISA_MODULE = `
  export type Paisa = number & { readonly __brand: 'Paisa' };
  export function paisa(v: number): Paisa { return v as Paisa; }
`;

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeFixture(files: Record<string, string>): string[] {
  dir = mkdtempSync(path.join(tmpdir(), 'money-guard-'));
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    paths.push(full);
  }
  return paths;
}

describe('findViolations', () => {
  it('flags multiplying a Paisa value by a bare number', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'bad.ts': `
        import { paisa } from './paisa.js';
        const price = paisa(500);
        const total = price * 3;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.operator).toBe('*');
    expect(violations[0]?.file.endsWith('bad.ts')).toBe(true);
  });

  it('flags dividing a Paisa value', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'bad.ts': `
        import { paisa } from './paisa.js';
        const price = paisa(500);
        const half = price / 2;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.operator).toBe('/');
  });

  it('flags a Paisa value on the right-hand side too', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'bad.ts': `
        import { paisa } from './paisa.js';
        const price = paisa(500);
        const total = 3 * price;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(1);
  });

  it('flags compound assignment on a Paisa value', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'bad.ts': `
        import { paisa } from './paisa.js';
        let price = paisa(500);
        price *= 2;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.operator).toBe('*=');
  });

  it('does not flag arithmetic on plain numbers', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'ok.ts': `
        const qty = 3;
        const total = qty * 2;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(0);
  });

  it('does not flag addition or subtraction of Paisa values', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'ok.ts': `
        import { paisa } from './paisa.js';
        const a = paisa(100);
        const b = paisa(200);
        const total = a + b;
        const diff = a - b;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: () => false });
    expect(violations).toHaveLength(0);
  });

  it('does not flag Paisa arithmetic in an excluded file', () => {
    const files = writeFixture({
      'paisa.ts': PAISA_MODULE,
      'money/helpers.ts': `
        import { paisa } from '../paisa.js';
        const price = paisa(500);
        const total = price * 3;
      `,
    });
    const program = createProgramForFiles(files);
    const violations = findViolations(program, { isExcluded: (f) => f.includes('/money/') });
    expect(violations).toHaveLength(0);
  });
});
