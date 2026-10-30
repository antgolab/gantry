import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPrototypeGate, readPrototypeNotes } from '../src/lib/prototype.mjs';
import { checkGate } from '../src/lib/phases.mjs';
import { buildPack } from '../src/lib/context-pack.mjs';
import { readState, writeState } from '../src/lib/state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-prototype-'));
  const specs = join(root, '.gantry/specs/demo');
  mkdirSync(specs, { recursive: true }); mkdirSync(join(root, 'src'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, specs };
}
function note(specs, { decision = 'Continue', artifact = 'src/cart.prototype.mjs', verdict = 'Only one transition is needed.', task = 'T01' } = {}) {
  writeFileSync(join(specs, 'PROTOTYPE.md'), `# Prototype\n\n## Question\nCan cancellation reverse a payment?\n\n## Artifact\n${artifact}\n\n## Run\nnode src/cart.prototype.mjs\n\n## Verdict\n${verdict}\n\n## Decision\n${decision}\n\n## Task\n${task}\n`);
}

test('change without a prototype keeps existing behavior', t => {
  const { root, specs } = fixture(t); assert.equal(checkPrototypeGate(specs, root).passed, true);
  assert.equal(checkPrototypeGate(specs, root).skipped, true);
});
test('Continue is unresolved exploration and never delivery evidence', t => {
  const { root, specs } = fixture(t); note(specs);
  const result = checkPrototypeGate(specs, root);
  assert.equal(result.passed, false); assert.match(result.reason, /Continue/);
});
test('Delete requires a verdict and the actual artifact to be gone', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Delete' });
  writeFileSync(join(root, 'src/cart.prototype.mjs'), 'throwaway');
  assert.equal(checkPrototypeGate(specs, root).passed, false);
  rmSync(join(root, 'src/cart.prototype.mjs'));
  assert.equal(checkPrototypeGate(specs, root).passed, true);
  note(specs, { decision: 'Delete', verdict: '' });
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});
test('Absorb needs a completed formal task and verification, not prototype QA', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Absorb' });
  assert.equal(checkPrototypeGate(specs, root).passed, false);
  writeFileSync(join(specs, 'TASKS.md'), '<task id="T01" status="pending"><write_files>src/cart.mjs</write_files><verify>node --test tests/cart.test.mjs</verify><done>Cancellation is reversible</done></task>');
  assert.equal(checkPrototypeGate(specs, root).passed, false);
  writeFileSync(join(specs, 'TASKS.md'), '<task id="T01" status="done"><write_files>src/cart.mjs</write_files><verify>node --test tests/cart.test.mjs</verify><done>Cancellation is reversible</done></task>');
  assert.equal(checkPrototypeGate(specs, root).passed, false, 'done text without a current receipt is not enough');
  assert.equal(checkPrototypeGate(specs, root, { validateTask: task => task.id === 'T01' }).passed, true);
  writeFileSync(join(root, 'src/cart.prototype.mjs'), 'throwaway still present');
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});
test('formal task cannot use prototype source or a prototype command as shipping proof', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Absorb' });
  for (const [files, verify] of [['src/cart.prototype.mjs', 'node --test tests/cart.test.mjs'], ['src/cart.mjs', 'node src/cart.prototype.mjs']]) {
    writeFileSync(join(specs, 'TASKS.md'), `<task id="T01" status="done"><write_files>${files}</write_files><verify>${verify}</verify><done>works</done></task>`);
    assert.equal(checkPrototypeGate(specs, root, { validateTask: () => true }).passed, false);
  }
});
test('unsafe artifact paths and unresolved placeholders fail closed', t => {
  const { root, specs } = fixture(t);
  for (const artifact of ['../elsewhere.mjs', '/tmp/elsewhere.mjs', 'src/*.mjs']) {
    note(specs, { decision: 'Delete', artifact }); assert.equal(checkPrototypeGate(specs, root).passed, false);
  }
  note(specs, { decision: 'Delete', verdict: '<What we learned>' });
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});
test('each selected prototype is inspected, including nested notes', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Delete' });
  mkdirSync(join(specs, 'prototypes'));
  writeFileSync(join(specs, 'prototypes/second.md'), '# Missing lifecycle data');
  assert.equal(readPrototypeNotes(specs).length, 2);
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});

test('dangling or outside symlinks are not treated as deleted prototype files', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Delete' });
  symlinkSync('/tmp/gantry-prototype-missing-file', join(root, 'src/cart.prototype.mjs'));
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});
test('machine-readable fields tolerate template guidance comments, not duplicate decisions', t => {
  const { root, specs } = fixture(t); note(specs, { decision: 'Delete' });
  const path = join(specs, 'PROTOTYPE.md');
  writeFileSync(path, '# Prototype\n## Question\nOne question\n## Artifact\nsrc/cart.prototype.mjs\n## Run\nnode src/cart.prototype.mjs\n## Verdict\nObserved one state\n## Decision\nDelete\n<!-- guidance -->\n');
  assert.equal(checkPrototypeGate(specs, root).passed, true);
  writeFileSync(path, '# Prototype\n## Decision\nDelete\n## Decision\nContinue\n');
  assert.equal(checkPrototypeGate(specs, root).passed, false);
});

test('phase transitions enforce prototype disposal and context loads the optional protocol', t => {
  const { root, specs } = fixture(t); note(specs);
  writeFileSync(join(specs, 'TEST.md'), '# TEST\n');
  writeFileSync(join(specs, 'REVIEW.md'), '# APPROVED\n');
  for (const stage of ['review', 'integration']) {
    const result = checkGate(stage, specs, {}, null, root);
    assert.equal(result.passed, false); assert.equal(result.hard, true); assert.match(result.reason, /Continue/);
  }
  writeState(root, { ...readState(root), activeChange: 'demo', currentStage: 'design' });
  assert.ok(buildPack(root).loadOrder.some(entry => entry.path.endsWith('/2-prototype.md')));
  note(specs, { decision: 'Delete' });
  assert.equal(checkGate('review', specs, {}, null, root).passed, true);
  assert.equal(checkGate('integration', specs, {}, null, root).passed, true);
  note(specs, { decision: 'Absorb' });
  writeFileSync(join(specs, 'TASKS.md'), '<task id="T01" status="done"><write_files>src/cart.mjs</write_files><verify>node --test tests/cart.test.mjs</verify><done>Works</done></task>');
  assert.equal(checkGate('integration', specs, {}, null, root).passed, false, 'formal task text cannot substitute for its receipt');
});
