import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createTaskRecord, readTaskRecord, writeTaskRecord, taskRecordPath,
  reserveAttempt, recordExternalRetry, acquireWorkspaceLock, releaseWorkspaceLock,
} from '../src/lib/task-record.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-record-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function create(root) {
  return createTaskRecord(root, 'test-change', { id: 'T01' }, { digest: 'contract' }, { entries: [] });
}

test('record persists identity, snapshots and revision without a duplicate task done state', () => fixture(root => {
  const record = create(root);
  assert.equal(record.revision, 0);
  assert.equal(record.repairsUsed, 0);
  assert.equal(record.status, undefined);
  assert.deepEqual(readTaskRecord(root, 'test-change', 'T01'), record);
  record.failure = { kind: 'repairable', summary: 'expected two rows' };
  const updated = writeTaskRecord(root, record);
  assert.equal(updated.revision, 1);
  assert.equal(readTaskRecord(root, 'test-change', 'T01').failure.summary, 'expected two rows');
}));

test('missing record is null; corrupt, unsupported, mismatched and unsafe identities fail closed', () => fixture(root => {
  assert.equal(readTaskRecord(root, 'test-change', 'T01'), null);
  const record = create(root);
  const path = taskRecordPath(root, 'test-change', 'T01');
  for (const text of ['{', JSON.stringify({ ...record, schemaVersion: 7 }), JSON.stringify({ ...record, taskId: 'T02' }), JSON.stringify({ ...record, repairsUsed: -1 })]) {
    writeFileSync(path, text);
    assert.throws(() => readTaskRecord(root, 'test-change', 'T01'), /record/);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  assert.throws(() => taskRecordPath(root, '../escape', 'T01'), /identity/);
  assert.throws(() => taskRecordPath(root, 'test-change', '../T01'), /identity/);
}));

test('initial attempt and three repairs survive a new process, with no fourth repair', () => fixture(root => {
  let record = reserveAttempt(root, create(root));
  assert.equal(record.attempt.repairOrdinal, 0);
  assert.equal(record.repairsUsed, 0);
  assert.throws(() => reserveAttempt(root, record), /initial/);
  for (let n = 1; n <= 3; n++) {
    record = reserveAttempt(root, record, { repair: true });
    assert.equal(record.attempt.repairOrdinal, n);
    assert.equal(record.repairsUsed, n);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readTaskRecord } from ${JSON.stringify(new URL('../src/lib/task-record.mjs', import.meta.url).href)}; process.stdout.write(String(readTaskRecord(${JSON.stringify(root)}, 'test-change', 'T01').repairsUsed))`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, String(n));
  }
  assert.throws(() => reserveAttempt(root, record, { repair: true }), /exhausted/);
  assert.equal(readTaskRecord(root, 'test-change', 'T01').repairsUsed, 3);
}));

test('external retries persist separately from business repairs and cannot exceed three', () => fixture(root => {
  let record = reserveAttempt(root, create(root), { ownerNonce: 'owner' });
  for (let n = 1; n <= 3; n++) {
    record = recordExternalRetry(root, record);
    assert.equal(record.attempt.externalRetriesUsed, n);
    assert.equal(record.repairsUsed, 0);
  }
  assert.throws(() => recordExternalRetry(root, record), /external.*exhausted/);
}));

test('a running executor prevents a new reservation without consuming budget', () => fixture(root => {
  let record = reserveAttempt(root, create(root));
  record = writeTaskRecord(root, { ...record, attempt: { ...record.attempt, lifecycle: 'running' } });
  assert.throws(() => reserveAttempt(root, record, { repair: true }), /still running/);
  assert.equal(readTaskRecord(root, 'test-change', 'T01').repairsUsed, 0);
}));

test('stale writes cannot reset budget or overwrite new revisions', () => fixture(root => {
  const original = create(root);
  const current = reserveAttempt(root, original);
  assert.throws(() => writeTaskRecord(root, original), /revision/);
  const repaired = reserveAttempt(root, current, { repair: true });
  assert.throws(() => writeTaskRecord(root, {
    ...repaired, repairsUsed: 0, attempt: { ...repaired.attempt, repairOrdinal: 0 },
  }), /budget/);
  assert.equal(readTaskRecord(root, 'test-change', 'T01').repairsUsed, 1);
}));

test('workspace lock rejects competitors and only nonce owner may borrow or release', () => fixture(root => {
  const lock = acquireWorkspaceLock(root);
  assert.ok(lock.ownerNonce);
  assert.throws(() => acquireWorkspaceLock(root), /locked/);
  const borrowed = acquireWorkspaceLock(root, { ownerNonce: lock.ownerNonce });
  assert.equal(borrowed.borrowed, true);
  releaseWorkspaceLock(root, borrowed);
  assert.throws(() => acquireWorkspaceLock(root), /locked/);
  assert.throws(() => releaseWorkspaceLock(root, { ...lock, ownerNonce: 'wrong' }), /owner/);
  releaseWorkspaceLock(root, lock);
  const next = acquireWorkspaceLock(root);
  assert.notEqual(next.ownerNonce, lock.ownerNonce);
  releaseWorkspaceLock(root, next);
}));

test('unknown or malformed old lock is retained rather than guessed stale or removed', () => fixture(root => {
  const lock = acquireWorkspaceLock(root);
  const ownerPath = join(root, '.gantry/planning/ralph.lock/owner.json');
  writeFileSync(ownerPath, '{');
  assert.throws(() => acquireWorkspaceLock(root), /locked/);
  assert.throws(() => releaseWorkspaceLock(root, lock), /owner/);
  assert.equal(readFileSync(ownerPath, 'utf8'), '{');
}));

test('independent process is blocked while an inherited owner nonce can write', () => fixture(root => {
  create(root);
  const lock = acquireWorkspaceLock(root);
  const script = `import { readTaskRecord, writeTaskRecord } from ${JSON.stringify(new URL('../src/lib/task-record.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const record = readTaskRecord(root, 'test-change', 'T01');
    writeTaskRecord(root, { ...record, failure: { kind: 'external', summary: 'child result' } });`;
  const env = { ...process.env };
  delete env.GANTRY_RALPH_OWNER_NONCE;
  const competitor = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.notEqual(competitor.status, 0);
  assert.match(competitor.stderr, /workspace locked/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...env, GANTRY_RALPH_OWNER_NONCE: lock.ownerNonce },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readTaskRecord(root, 'test-change', 'T01').failure.summary, 'child result');
  assert.throws(() => acquireWorkspaceLock(root), /locked/);
  releaseWorkspaceLock(root, lock);
}));
