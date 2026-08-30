import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createProgramForFiles, findViolations, type Violation } from './checker.js';

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.git']);

function listTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  if (statSync(rootDir, { throwIfNoEntry: false })) walk(rootDir);
  return out;
}

/**
 * Scan every `.ts` source file under `apps/` and `packages/` (the whole
 * shipped workspace) for bare `*`/`/` arithmetic on a `Paisa` value,
 * excluding the money module itself (any "money" directory), which is
 * the only place allowed to do that arithmetic.
 */
export function scanWorkspace(workspaceRoot: string): Violation[] {
  const files = [...listTsFiles(path.join(workspaceRoot, 'apps')), ...listTsFiles(path.join(workspaceRoot, 'packages'))];
  const program = createProgramForFiles(files);
  return findViolations(program, {
    isExcluded: (fileName) => /[/\\]money[/\\]/.test(fileName),
  });
}
