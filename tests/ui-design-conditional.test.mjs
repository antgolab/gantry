/**
 * ui-design-conditional.test.mjs — 验证 ui-design 阶段的「非前端自动跳过」
 *
 * 覆盖：
 *   - detectFrontend() 三态：前端包 / 前端配置文件 / 明确非前端 / 无从判断
 *   - shouldSkipConditional() 的 enabled:'auto'+condition:'frontend' 判定
 *   - getNextStage() 在非前端时跳过 ui-design、前端时保留
 *   - checkGate() 对条件跳过阶段直接放行
 *   - 向后兼容：_isFrontend 缺失（老项目）时不跳过
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectFrontend } from '../src/lib/detect.mjs';
import { getNextStage, checkGate, shouldSkipConditional } from '../src/lib/phases.mjs';

const TMP = join(import.meta.dirname, '.tmp-uicond');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
}
function teardown() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

// full 管线下 ui-design 的默认 config（对齐 cli.mjs init 写入）
const UI_AUTO_CFG = {
  pipeline: 'full',
  stages: { 'ui-design': { enabled: 'auto', condition: 'frontend' } },
};

describe('detectFrontend · 三态判定', () => {
  it('package.json 含 react 依赖 → true', () => {
    setup();
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    assert.equal(detectFrontend(TMP), true);
    teardown();
  });

  it('package.json 含 vue devDependency → true', () => {
    setup();
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ devDependencies: { vue: '^3.0.0' } }));
    assert.equal(detectFrontend(TMP), true);
    teardown();
  });

  it('存在 next.config.mjs → true（不依赖 package.json 可解析）', () => {
    setup();
    writeFileSync(join(TMP, 'next.config.mjs'), 'export default {};');
    assert.equal(detectFrontend(TMP), true);
    teardown();
  });

  it('存在 vite.config.ts → true', () => {
    setup();
    writeFileSync(join(TMP, 'vite.config.ts'), 'export default {};');
    assert.equal(detectFrontend(TMP), true);
    teardown();
  });

  it('有 package.json 但无前端信号（纯 CLI 工具）→ false', () => {
    setup();
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ dependencies: { commander: '^12.0.0' } }));
    assert.equal(detectFrontend(TMP), false);
    teardown();
  });

  it('无 package.json 且无前端配置文件 → undefined（无从判断）', () => {
    setup();
    assert.equal(detectFrontend(TMP), undefined);
    teardown();
  });

  it('package.json 损坏无法解析 → undefined', () => {
    setup();
    writeFileSync(join(TMP, 'package.json'), '{ not valid json');
    assert.equal(detectFrontend(TMP), undefined);
    teardown();
  });
});

describe('shouldSkipConditional · 条件门判定', () => {
  it('auto+frontend 且 _isFrontend=false → 跳过', () => {
    assert.equal(shouldSkipConditional('ui-design', { ...UI_AUTO_CFG, _isFrontend: false }), true);
  });

  it('auto+frontend 且 _isFrontend=true → 不跳过', () => {
    assert.equal(shouldSkipConditional('ui-design', { ...UI_AUTO_CFG, _isFrontend: true }), false);
  });

  it('auto+frontend 且 _isFrontend=undefined → 不跳过（保守）', () => {
    assert.equal(shouldSkipConditional('ui-design', { ...UI_AUTO_CFG }), false);
  });

  it('enabled=true（非 auto）不受条件门影响', () => {
    assert.equal(shouldSkipConditional('ui-design', {
      stages: { 'ui-design': { enabled: true } }, _isFrontend: false,
    }), false);
  });

  it('无该阶段配置 → 不跳过', () => {
    assert.equal(shouldSkipConditional('ui-design', { stages: {}, _isFrontend: false }), false);
  });
});

describe('getNextStage · 非前端跳过 ui-design', () => {
  it('full + 非前端: design → task（跳过 ui-design）', () => {
    assert.equal(getNextStage('design', { ...UI_AUTO_CFG, _isFrontend: false }), 'task');
  });

  it('full + 前端: design → ui-design', () => {
    assert.equal(getNextStage('design', { ...UI_AUTO_CFG, _isFrontend: true }), 'ui-design');
  });

  it('full + 未探测(undefined): design → ui-design（向后兼容，不跳过）', () => {
    assert.equal(getNextStage('design', { ...UI_AUTO_CFG }), 'ui-design');
  });

  it('默认图路径同样受条件门约束（非前端跳过 ui-design）', () => {
    // 不给 pipeline，走 STAGES.next 默认图：design.next=[ui-design, task]
    assert.equal(getNextStage('design', {
      stages: { 'ui-design': { enabled: 'auto', condition: 'frontend' } }, _isFrontend: false,
    }), 'task');
  });
});

describe('checkGate · 条件跳过阶段直接放行', () => {
  it('非前端进入 ui-design → passed（跳过，不查 DESIGN.md 工件）', () => {
    setup();
    // 故意不写 DESIGN.md：若未走条件跳过，staticGate 会因缺工件失败
    const r = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _isFrontend: false });
    assert.equal(r.passed, true);
    assert.match(r.reason, /non-frontend/);
    teardown();
  });

  it('前端进入 ui-design → 仍走 DESIGN.md 工件门禁（缺则失败）', () => {
    setup();
    const r = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _isFrontend: true });
    assert.equal(r.passed, false);
    teardown();
  });

  it('前端且 DESIGN.md 存在 → 通过', () => {
    setup();
    writeFileSync(join(TMP, 'DESIGN.md'), '# design');
    const r = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _isFrontend: true });
    assert.equal(r.passed, true);
    teardown();
  });
});
