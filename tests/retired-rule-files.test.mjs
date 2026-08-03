import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadAgents, loadCore } from '../tools/lib/loader.mjs';

const ROOT = join(import.meta.dirname, '..');

test('retired split rule files are absent from core and agent prompts', () => {
  const core = loadCore(ROOT);
  const agents = loadAgents(join(ROOT, 'src', 'agents'));

  assert.equal('ruleFiles' in core, false);
  for (const [name, content] of Object.entries(agents)) {
    assert.equal(content.includes('core/rules/'), false, `${name} still references core/rules/`);
  }
});
