---
name: gantry:exec
description: 已内部化 · dev 阶段由 /gantry-next / /gantry-auto 自动触发
agent: executor
stage: dev
---

# /gantry:exec（内部机制）

由 `/gantry-next` 或 `/gantry-auto` 加载，执行已预约的单个任务的一次候选编码。共享工作区逐 task 顺序执行，wave 不产生并行写或额外修复预算。

## 控制器协议

1. 宿主运行 `gantry dispatch --json` 预约一个 ready task，读取返回的 contextPack；不再调用 context 重建。
2. 为该次预约创建 fresh executor subagent，交付单任务 pack；把 pack JSON 冻结为当前 attempt 的输入；当前候选返回前不切换共享 pack。按 loadOrder 加载 agent/phase 等约束，checklists.trigger=true 必须执行。
3. worker 以 write_files 为计划范围，额外文件列出路径但不阻断；实现前消费失败诊断和 lessons，按 RED→GREEN→REFACTOR，报告实际 verify 和自查。语法/runner 错误不算有效 RED，纯文档等例外写明理由。
4. worker 交还候选，不自行 commit，不执行 `gantry done/dispatch/advance`，不改 TASKS/EXECUTION、验收 contract 或控制 JSON。pack 的 `next.onSuccess` 由宿主执行。
5. 宿主运行 `gantry done <id> --json`，独立验收后才完成任务。业务失败经同一内核预约修复，初次 + 最新 `ralph.maxRepairs` 次修复（默认3），先扣额度，失败接力使用 fresh context；禁止主上下文接管清零或整体回退 wave。
6. 中断先重验候选；记录缺失、损坏或旧锁归属不明时保留现场，不静默建立“原始基线”。全部 done 后仅由宿主调用 advance，完成组合检查、安全统一提交并离开 DEV。

执行完整规则见 `phases/4-dev.md` 的「单任务编排」和「单任务执行」。light/fast 沿用 `phases/F-fast.md`。

失败处理复用 当前工具的 `gantry-next` 入口「门禁修复循环」：先读 gateFeedback/retryHistory/task record，测试删除、flaky、runner 和预检问题先调查修复，契约漂移恢复原验收。候选进程内持续推理和本地验证，外层修复预约和最终报错由宿主管理，不因单次检查返回 blocked 就自行结束整个流程，也不在 worker 内再开外层重试。

唯一例外：验收字段被误改时，只允许将当前任务的 verify/done/checks/preflight 精确恢复为传入的已保存 contract 原值；不修改 contract 控制记录、TASKS 完成状态或其他任务，不重新定义验收。
