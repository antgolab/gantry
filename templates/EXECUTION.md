# EXECUTION: <change-id>

> change 级执行日志。默认在这里累积每个 task 的完成证据；仅高风险任务才单独拆 `<task-id>-SUMMARY.md`。

## Entries

### T01

- status: done
- completed_at: <YYYY-MM-DDTHH:mm:ssZ>
- summary: <实际完成内容>
- verify: <执行过的验证命令>
- evidence: <输出摘要 / 路径 / 关键结论>
- notes: <偏离 / 风险 / follow-up>

## AI 自动决策

> 记录本阶段内所有未触发 requiresApproval 硬锁 / 未触发 R5/R6/R7 的自动决策及其依据。

格式（ADR-001 单行三段式）：`- <问题>？→ <决议> · <依据路径>`

示例：
- 新段落应插在模板哪一节？→ 放在「执行记录」后、「归档」前 · `.gantry/specs/ai-decision-gate/DESIGN.md` D5 决议

> 若本阶段无需自动决策，须写一行 `- (本阶段无需自动决策)` 作占位，不留空标题。
