---
name: gantry:resume
description: 断点恢复（新会话接力）
agent: auto
stage: auto
---

# /gantry:resume

从仓库工件恢复当前工作，不另建一套上下文加载清单。

## 执行协议

1. 读取 STATE 与 context-pack，核对 stage / change / task；pack 缺失或不匹配时用 `gantry context` 刷新。新会话按 loadOrder / focus 加载，当前上下文已读且未变化的内容直接复用。
2. 人工确认等待：先确认当前阶段产物已可审阅，再展示并等待用户明确继续；不自行批准或重写已审阅工件。
3. DEV 中断：按 pack 中当前任务的 PROGRESS 读取已排除方案、续接点和待确认假设。已有候选或 receipt 时由宿主先运行 `gantry done <id> --json` 重验，再按结果继续单任务协议；不靠 git log 猜完成，不重复预约或重置预算。worker 不调用 done。
4. 读取原 task record / metrics.jsonl 中的已用预算和最后诊断；历史 pauseReason/blockedReason 不单独阻断。可恢复问题按 当前工具的 `gantry-next` 入口「门禁修复循环」继续，已耗尽则只重验外部修复后的内容，不再派发模型；不能因恢复、清窗或换入口清零。其他阶段按当前 phase 协议续接，完成后由宿主 advance 验门。
5. 输出 change、stage、task、中断原因和续接点即可，不另写恢复报告。未知锁、损坏记录或缺失任务前基线保留现场，按现有迁移约束处理。
