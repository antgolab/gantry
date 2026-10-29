---
name: gantry:next
description: 推进到下一阶段
agent: auto
stage: auto
---

# /gantry:next

执行当前阶段直到本阶段产物完成，然后推进到下一阶段。用户只需要调用这个入口；机械状态推进由内部命令 `gantry advance` 完成。

## 执行协议

1. 读取 `.gantry/planning/STATE.md` 获取当前阶段和 active change
2. 读取 `.gantry/planning/context-pack.json`；不存在时运行 `gantry context` 生成
3. 按 `context-pack.json.loadOrder` 加载当前阶段 phase prompt 和必要工件
4. 执行当前阶段协议，直到本阶段要求的产物完成且自检通过
5. 运行 `gantry advance` 做机械门禁校验、状态转换和 context-pack 刷新；若当前是人工关卡，只有用户审阅并明确继续后才调用 `gantry advance --approve <stage>`，绑定实际工件摘要，worker 不得自行批准
6. 如果进入人工确认关卡，停下让用户审阅；否则告知下一步继续调用 `/gantry-next`

## 各阶段完成定义

| 当前阶段 | 本次必须完成的产物 |
|----------|--------------------|
| change | `.gantry/specs/<id>/PROPOSAL.md`，且 `## 待澄清问题` 为 `无` |
| requirement | `.gantry/specs/<id>/SPEC.md`，必要时更新 `.gantry/specs/CONTEXT.md` |
| design | `.gantry/specs/<id>/DESIGN.md` |
| ui-design | `.gantry/specs/<id>/UI-DESIGN.md` |
| task | `.gantry/specs/<id>/TASKS.md` |
| dev | 用 dispatch 预约单个 ready task，fresh executor 交候选，宿主 done 实际验收；全部有效凭据及组合检查通过后统一提交再推进 |
| test | `.gantry/specs/<id>/TEST.md` |
| review | `.gantry/specs/<id>/REVIEW.md` |
| integration | 完成集成确认；通常随后运行 `gantry archive` |

## 门禁规则

| 目标阶段 | 前置条件 |
|----------|----------|
| requirement | `PROPOSAL.md` 存在 |
| design | `SPEC.md` 存在 |
| task | DESIGN.md 存在 |
| dev | `TASKS.md` 存在 |
| test | 所有 task status=done 且内容 receipt 有效，DEV 组合验证及安全提交完成 |
| review | TEST.md 存在 |
| integration | REVIEW.md 存在且通过 |

## 失败处理

- 阶段产物缺失或自检未过：不要推进，说明缺口并继续补产物。
- 人工批准绑定当前工件；`--skip` 无法跳过人工关卡或 DEV 完成证据。
- `gantry advance` 门禁失败：按错误提示修复当前阶段产物；只有用户明确要求时才使用 `gantry advance --skip`。
- 需要用户回答的问题：最多一次问 3 个，等用户回答后继续当前阶段，不要先推进。
