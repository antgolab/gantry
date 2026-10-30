# 在正式设计前验证一个问题

当交互、状态迁移或 API 体验只能通过操作来判断时，可以在当前 change 内做一个可丢弃原型。它是现有 CHANGE / DESIGN 的可选分支，不增加管线阶段或公开 skill。

例如要确认“用户撤销付款时到底需要看到哪些状态”，先用内存状态机和几个终端操作展示变化。在当前 change 新建 `PROTOTYPE.md`，沿用 [模板](../templates/PROTOTYPE.md) 记录一个 Question、Artifact 相对路径、Run 命令、观察到的 Verdict 和 Decision。多个原型使用 `prototypes/<slug>.md`。

原型默认不连接真实生产写入，不创建新的包管理器、数据库或运行时，不为可能丢弃的探索代码增加生产测试和架构。探索结束后选择：

- `Delete`：保留结论，删除一次性文件。
- `Absorb`：将选定方案写进正式任务，移到 production 文件，完成任务的 verify；删除原型外壳。
- `Continue`：问题仍未回答，继续探索，当前 change 不能交付。

integration 门禁会实际检查文件是否移除、Absorb 是否对应已完成且声明 write_files/done/verify 的任务，并要求当前有效的任务 receipt。检查正式任务存在不能替代 AC 运行证据；AC 仍由原有门禁独立确认。不要把原型的截图或演示成功直接登记为正式 AC 成功。

代码质量整理挂在现有 REVIEW 里。新增多行逻辑触发复用、复杂度、效率、修复层次四个角度，小型常量或文档修改跳过。Reviewer 只产建议与修复任务，executor 在当前 diff 和 task.write_files 范围内修复并重跑 verify；越界先走 PATCH，行为改变转回正常需求/设计处理。

验证：`node --test tests/prototype-gate.test.mjs tests/simplify-scope.test.mjs`。

可将 reviewer 建议保存为 JSON 数组，再运行只读边界检查：

```bash
gantry context --task T01 --simplify-findings /tmp/findings.json
```

每个建议至少带 `file`、正整数 `line`，行为改变时标注 `behaviorChanging: true`。CLI 对照任务 write_files 和实际 review diff；越界返回 PATCH，不会自动改代码。默认使用未提交 diff；DEV 已提交且工作区干净时使用最近 commit，确保 REVIEW 不会漏掉刚完成的代码。
