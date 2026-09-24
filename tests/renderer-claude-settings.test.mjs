import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../tools/renderers/claude-code.mjs';

describe('claude-code renderer __merge__ settings', () => {
  it('includes the __merge__/.claude/settings.json key in render output', () => {
    const files = render({ phases: {} }, {}, {});
    assert.ok('__merge__/.claude/settings.json' in files, 'should emit __merge__ settings key');
  });

  it('merge value is an object whose addToAllow contains exactly "Bash(gantry *)"', () => {
    const files = render({ phases: {} }, {}, {});
    const merge = files['__merge__/.claude/settings.json'];
    assert.equal(typeof merge, 'object', 'value must be an object, not a string');
    assert.notEqual(merge, null, 'value must not be null');
    assert.ok(Array.isArray(merge.addToAllow), 'addToAllow must be an array');
    assert.deepEqual(merge.addToAllow, ['Bash(gantry *)'], 'addToAllow must contain only Bash(gantry *)');
  });

  it('keeps the existing CLAUDE.md key (regression guard)', () => {
    const files = render({ phases: {} }, {}, {});
    assert.ok('CLAUDE.md' in files, 'CLAUDE.md must still be present');
    assert.equal(typeof files['CLAUDE.md'], 'string', 'CLAUDE.md value must remain a string');
  });
});
