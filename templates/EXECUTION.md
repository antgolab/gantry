# EXECUTION: <change-id>

> change 级执行日志。控制器投影真实验收凭据，编排器一次合入任务报告；不逐项读改日志。同一证据只保留一份，其他位置引用 task 段或已有日志路径。SUMMARY 仅承载需独立交接的高风险/例外细节，EXECUTION 只留摘要与链接。

## Entries

### T01

- status: done
- completed_at: <YYYY-MM-DDTHH:mm:ssZ>
- summary: <实际完成内容>
- verify: <执行过的验证命令>
- evidence: <输出摘要 / 路径 / 关键结论>
- problem: <踩坑、返工或阻力；无则 none，不得凑数>
- cause: <问题根因；problem 为 none 时写 none>
- next: <下次具体改变什么以及如何验证；无则 none，禁止只写“注意检查”>

## AI 自动决策（有实际决策时保留）

> 只记录影响后续执行的自动决策及其依据；无内容时省略本节。

格式（ADR-001 单行三段式）：`- <问题>？→ <决议> · <依据路径>`

示例：
- 新段落应插在模板哪一节？→ 放在「执行记录」后、「归档」前 · `.gantry/specs/ai-decision-gate/DESIGN.md` D5 决议
