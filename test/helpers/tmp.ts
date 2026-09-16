/**
 * One temp directory per test, removed even when the test throws. Shared so
 * the cleanup contract lives in a single place instead of being re-derived in
 * every test file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function withTempDir<T>(fn: (dir: string) => T, prefix = 'fleet-'): T {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
