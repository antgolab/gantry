# EXECUTION: <change-id>

> change 级执行日志。默认在这里累积每个 task 的完成证据；仅高风险任务才单独拆 `<task-id>-SUMMARY.md`。

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
