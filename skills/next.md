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
3. 按 `context-pack.json.loadOrder` 加载当前阶段 agent、phase 和必要工件；有 `focus` 时按节读，同一上下文已读且未变化的内容直接复用
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
- `gantry advance` 门禁失败：先按下述「门禁修复循环」处理；可恢复错误不在首次失败时交回用户，不能用 `--skip` 替代真实修复。
- 需要用户回答的问题：最多一次问 3 个，等用户回答后继续当前阶段，不要先推进。

## 门禁修复循环

1. 消费冻结 pack 的 `gateFeedback`、`retryHistory` 与当前 task record 的 `failure`/命令输出；缺工件、hook 失败、研究/原型/PATCH 未闭环、测试或组合验证失败、flaky、runner 缺失等先诊断根因。历史 `blockedReason` 是诊断，不单独作为停止依据。
2. 在剩余预算内持续「收集新证据 → 修复根因 → 重新运行失败命令和实际门禁」。不复述同一报错、无差异重跑或仅产 fix-plan 就结束。报告问题由当前角色补齐；实现问题交 executor 修复再回到当前验证，Reviewer 不直接改代码。契约漂移只能恢复保存的原验收，不能降低标准；计划文件列表差异只记录提示。
3. 宿主统一管理外层重试：DEV 使用最新 `.gantry/planning/config.json` 的 `ralph.maxRepairs`，阶段（含 light）使用 `autonomous.maxRetries`，均默认3。初次候选不算修复；DEV 预约先落盘再执行。读取现有 task record / `metrics.jsonl`，重启、清窗、换 skill 不清零。skill、phase、hook、review 不另起一套重试计数，不相乘放大预算；执行者不改预算、状态或锁。
4. headless loop 的一次 adapter 调用只返回一个候选和诊断，由外层复验/预约；不要在候选进程内再启动 `gantry loop`。交互宿主用 dispatch/done/advance 完成各自事务；若单步命令只返回检查结果而不提供该阻塞的修复预约，由宿主选择匹配当前客户端的 `gantry loop codex|claude` 接管有界收敛，不在 skill 中伪造预约或无限重跑单步命令。有效凭据可复用，但组合门禁失败必须带着诊断再次修复，不能只循环验收。
5. 仅在已用修复额度耗尽、人工确认/确需用户提供的新决策或凭据、取消/时限、锁冲突/活跃进程/清理未确认、控制记录损坏/缺原始基线、用户内容归属不明时停止。报告具体原因、已用/上限、已尝试方案与最后证据，不把失败标为完成。

空 hook 按 pack 的 `hook-before`/`hook-after=false` 直接跳过，不调用、不重复探测；配置变化后再判断。已配置 hook 失败修复后实际重跑，不能通过删掉 hook 消除门禁。
