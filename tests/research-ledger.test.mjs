import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RESEARCH_SURFACES, parseResearchLedger, checkResearchLedger, selectResearchRows, researchContextEntries } from '../src/lib/research-ledger.mjs';
import { checkGate } from '../src/lib/phases.mjs';
import { buildPack } from '../src/lib/context-pack.mjs';
import { readState, writeState } from '../src/lib/state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-ledger-'));
  const dir = join(root, '.gantry/specs/demo'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'app.mjs'), 'export const app = true;');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir, write: (file, text) => writeFileSync(join(dir, file), text) };
}
function ledger(overrides = {}) {
  return '<!-- gantry:research-ledger -->\n## Research Coverage\n\n| surface | status | evidence | openDecision | scope |\n|---|---|---|---|---|\n'
    + RESEARCH_SURFACES.map(surface => `| ${surface} | ${overrides[surface]?.status ?? 'n/a-derived'} | ${overrides[surface]?.evidence ?? '纯文档变更，无此运行时表面'} | ${overrides[surface]?.openDecision ?? '—'} | ${overrides[surface]?.scope ?? '*'} |`).join('\n') + '\n';
}

test('quoted template examples never enable the ledger', () => {
  assert.equal(parseResearchLedger('> <!-- gantry:research-ledger -->\n> ## Research Coverage\n').enabled, false);
});
test('legacy change without ledger stays compatible', t => {
  const f = fixture(t); f.write('PROPOSAL.md', '# proposal\n## 待澄清问题\n无\n');
  assert.deepEqual(checkResearchLedger(f.dir), { passed: true, enabled: false, rows: [], errors: [] });
});
test('complete ledger accepts actual local evidence and records resolved rows', t => {
  const f = fixture(t); f.write('PROPOSAL.md', ledger({ contracts: { status: 'resolved-by-evidence', evidence: '`app.mjs:1`' } }));
  const result = checkResearchLedger(f.dir); assert.equal(result.passed, true, result.reason); assert.equal(result.rows.length, 7);
});
test('an open surface cannot pass by deleting its question or deleting the row', t => {
  const f = fixture(t); const text = ledger({ contracts: { status: 'open-needs-user', evidence: '—', openDecision: '谁拥有合同？' } });
  f.write('PROPOSAL.md', text); assert.equal(checkResearchLedger(f.dir).passed, false);
  f.write('PROPOSAL.md', text.replace('谁拥有合同？', '—')); assert.match(checkResearchLedger(f.dir).reason, /缺少待决问题/);
  f.write('PROPOSAL.md', text.split('\n').filter(line => !line.startsWith('| contracts |')).join('\n')); assert.match(checkResearchLedger(f.dir).reason, /缺少 surface contracts/);
});
test('enabled marker survives section deletion and missing columns fail closed', () => {
  assert.match(parseResearchLedger('researchLedger: true\n# removed').errors.join(' '), /段缺失/);
  assert.match(parseResearchLedger('## Research Coverage\n| surface | status |\n|---|---|\n').errors.join(' '), /缺少 evidence 列/);
});
test('n/a needs a reason, invalid and duplicate surfaces are rejected', () => {
  const bad = ledger({ experience: { evidence: '—' } }) + '| contracts | guessed | random | — | * |\n';
  const result = parseResearchLedger(bad); assert.match(result.errors.join(' '), /缺少证据/); assert.match(result.errors.join(' '), /重复 surface/); assert.match(result.errors.join(' '), /状态非法/);
});
test('external facts require official source URL, explicit version and deprecation status', t => {
  const f = fixture(t);
  f.write('PROPOSAL.md', ledger({ 'external-version': { status: 'resolved-by-evidence', evidence: 'https://nodejs.org/api/fs.html' } }));
  assert.match(checkResearchLedger(f.dir).reason, /version:/);
  f.write('PROPOSAL.md', ledger({ 'external-version': { status: 'resolved-by-evidence', evidence: 'https://nodejs.org/api/fs.html; version: 22; deprecated: no' } }));
  assert.equal(checkResearchLedger(f.dir).passed, true);
});
test('invented local references and paths outside the repo cannot resolve a question', t => {
  const f = fixture(t);
  for (const evidence of ['`missing.mjs:9`', '`../../etc/passwd`', '`/etc/passwd`']) {
    f.write('PROPOSAL.md', ledger({ contracts: { status: 'resolved-by-evidence', evidence } }));
    assert.match(checkResearchLedger(f.dir).reason, /路径不存在或越出/);
  }
});
test('DESIGN may resolve PROPOSAL pending decision with a cited user decision', t => {
  const f = fixture(t);
  f.write('PROPOSAL.md', ledger({ contracts: { status: 'open-needs-user', openDecision: '谁拥有合同？' } }));
  f.write('DESIGN.md', ledger({ contracts: { status: 'resolved-by-user', evidence: 'user: 用户确认合同归工作区' } }));
  assert.equal(checkResearchLedger(f.dir).passed, true);
  f.write('DESIGN.md', ledger({ contracts: { status: 'resolved-by-user', evidence: '我猜是工作区' } }));
  assert.match(checkResearchLedger(f.dir).reason, /user:/);
});
test('context only includes global, matching task and literal path scopes', t => {
  const f = fixture(t);
  f.write('PROPOSAL.md', ledger({ contracts: { scope: 'T01' }, lifecycle: { scope: 'src/user' }, experience: { scope: 'T99' } }));
  const rows = selectResearchRows(f.dir, { taskId: 'T01', files: ['src/user/view.mjs'] });
  assert.ok(rows.some(row => row.surface === 'contracts')); assert.ok(rows.some(row => row.surface === 'lifecycle')); assert.ok(!rows.some(row => row.surface === 'experience'));
  assert.deepEqual(researchContextEntries(f.dir, { taskId: 'T99' })[0].focus.includes('| experience |'), true);
  assert.equal(researchContextEntries(f.dir, { taskId: 'T99' })[0].path, '.gantry/specs/demo/PROPOSAL.md');
});

test('phase gate blocks open research and task context carries only relevant ledger rows', t => {
  const f = fixture(t);
  f.write('PROPOSAL.md', '# Proposal\n## 待澄清问题\n无\n' + ledger({ contracts: { status: 'open-needs-user', openDecision: 'Who owns this?', scope: 'T01' }, experience: { scope: 'T99' } }));
  const blocked = checkGate('requirement', f.dir, {}, null, f.root);
  assert.equal(blocked.passed, false); assert.equal(blocked.hard, true); assert.match(blocked.reason, /Who owns this/);
  f.write('PROPOSAL.md', '# Proposal\n## 待澄清问题\n无\n' + ledger({ contracts: { scope: 'T01' }, experience: { scope: 'T99' } }));
  assert.equal(checkGate('requirement', f.dir, {}, null, f.root).passed, true);
  writeState(f.root, { ...readState(f.root), activeChange: 'demo', currentStage: 'dev', currentTask: 'T01' });
  const pack = buildPack(f.root);
  const focus = pack.loadOrder.find(entry => entry.path.endsWith('/PROPOSAL.md')).focus.join('\n');
  assert.match(focus, /\| contracts \|/); assert.doesNotMatch(focus, /\| experience \|/);
  const review = buildPack(f.root, { stage: 'review' });
  assert.ok(!review.loadOrder.some(entry => entry.focus?.some(line => line.includes('| contracts |'))));
});
