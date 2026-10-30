---
name: gantry:exec
description: 已内部化 · dev 阶段由 /gantry-next / /gantry-auto 自动触发
agent: executor
stage: dev
---

# /gantry:exec（内部机制）

由 `/gantry-next` 或 `/gantry-auto` 加载，执行已预约的单个任务的一次候选编码。共享工作区逐 task 顺序执行，wave 不产生并行写或额外修复预算。

## 控制器协议

1. 宿主先运行 `gantry dispatch --json` 预约一个 ready task，再运行 `gantry context dev --task <id> --json`。
2. 为该次预约创建 fresh executor subagent，交付单任务 pack；把 pack JSON 冻结为当前 attempt 的输入；当前候选返回前不切换共享 pack。按 loadOrder 加载 agent/phase 等约束，checklists.trigger=true 必须执行。
3. worker 只写 write_files；实现前消费失败诊断和 lessons，按 RED→GREEN→REFACTOR，报告实际 verify 和自查。语法/runner 错误不算有效 RED，纯文档等例外写明理由。
4. worker 交还候选，不自行 commit，不执行 `gantry done/dispatch/advance`，不改 TASKS/EXECUTION、验收 contract 或控制 JSON。pack 的 `next.onSuccess` 由宿主执行。
5. 宿主运行 `gantry done <id> --json`，独立验收后才完成任务。业务失败经同一内核预约修复，初次 + 三次修复，先扣额度，失败接力使用 fresh context；禁止主上下文接管清零或整体回退 wave。
6. 中断先重验候选；记录缺失、损坏或旧锁归属不明时保留现场，不静默建立“原始基线”。全部 done 后仅由宿主调用 advance，完成组合检查、安全统一提交并离开 DEV。

执行完整规则见 `phases/4-dev.md` 的「单任务编排」和「单任务执行」。light/fast 沿用 `phases/F-fast.md`。
