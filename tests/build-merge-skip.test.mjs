import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('build skips __merge__ entries', () => {
  it('claude-code build succeeds and writes no __merge__ directory', () => {
    const out = mkdtempSync(join(tmpdir(), 'gantry-build-'));
    try {
      execFileSync(process.execPath, [join(ROOT, 'tools', 'build.mjs'), '--tool', 'claude-code', '--out', out], { cwd: ROOT, stdio: 'pipe' });
      assert.ok(existsSync(join(out, 'claude-code', 'CLAUDE.md')), 'CLAUDE.md should be generated');
      assert.ok(!existsSync(join(out, 'claude-code', '__merge__')), '__merge__ intents must not be written as files');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
