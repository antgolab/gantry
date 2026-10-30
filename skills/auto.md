---
name: gantry:auto
description: 自主模式（自动推进管线）
agent: auto
stage: auto
---

# /gantry:auto

读取仓库状态与当前 context pack，执行当前阶段产物，再通过门禁推进；最多运行 `config.autonomous.maxStagesPerRun`（默认 3）个阶段。full 的 Change、Design、Integration 保留人工关卡；light 在 fast 内按原出口门闭环，不使用 full task-cycle。

## 阶段协议

1. 设置 autonomous=true，按 pack.loadOrder 加载当前阶段约束。`loop-next` 的 full token 表示当前阶段，不是下一阶段。
2. 产物、自检与 verify 齐备后调用 `gantry advance`，不把机械推进当作阶段实现。
3. 进入人工关卡后先完成可审阅工件再停下。用户明确审阅并继续时，由宿主调用 `gantry advance --approve <当前阶段>`。批准绑定工件摘要；工件变化须重新审阅，worker 和 headless 重启不得自行批准，`--trust/--skip` 不能绕过。
4. 可恢复门禁按 当前工具的 `gantry-next` 入口「门禁修复循环」持续诊断、修复、重验，耗尽宿主预算才报告错误；达阶段上限、人工确认、取消/超时、控制状态或用户内容保护、管线完成时停止。失败重试不算成功推进阶段。

## DEV 单任务调度协议

共享工作区一次只允许一个任务写者；wave / `[P]` 是依赖和冲突视图，不启动共享目录并行写。

1. 运行 `gantry dispatch --json`，CLI 重验已完成依赖，固定任务前基线/验收 contract，并先持久化一次预约。
2. `dispatched` 含一个 `taskId`、`attemptId`、`repairOrdinal` 和 `contextPack` 路径；读取这份已生成的 pack，交给一个新的 executor subagent，不再调用 context 重建。worker 是叶子执行者，不创建或恢复其他子 Agent，只执行本次候选编码。
3. worker 以 task.write_files 为计划范围，额外文件列出路径但不阻断，一次尝试内按 RED→GREEN→REFACTOR，报告真实命令、退出码、关键断言及 problem/cause/next；纯文档任务说明 TDD 例外。worker 不改 TASKS/EXECUTION/STATE/execution 控制 JSON，不调用 done/dispatch/advance/archive，不 commit，不改验收 contract，不启动逃逸后台写者。
4. 等 worker 与受控写进程返回后，宿主运行 `gantry done <id> --json`。控制器独立执行 verify/checks、边界和弱化检查；成功凭据先落盘，再写 EXECUTION 和 TASKS。返回报告或勾选不算完成证据。
5. 可修复失败保留诊断，下一次预约必须新建 fresh executor。总上限为初次执行 + 最新 `ralph.maxRepairs` 次修复（默认3），先扣后启动，重启不清账。明确可重试的传输故障在同预约下最多额外三次，与业务额度分开。安全返回的未知故障、环境缺失、测试删除、flaky 和验收漂移先分析修复；漂移只能恢复原验收，文件列表差异只提示，确需新需求决策/凭据才向用户澄清；额度耗尽不转主上下文无限接管，不整体回退 wave。
6. 中断恢复先运行 done 重验已有候选；有效 receipt 可幂等补齐状态，不无条件重调模型。重复 dispatch 不代表已发生失败，不重复消费预约。记录损坏、旧锁所有权不明或旧任务缺任务前基线时保留现场并审阅迁移。
7. 任务成功后重新 dispatch。`all_done` 时运行 `gantry advance`：最终组合验证、安全暂存和索引重验后由 CLI 统一一个 DEV commit，再推进 TEST。组合验证失败即使局部凭据有效也必须交 executor 修复，不能只重复 advance。用户既有暂存内容、不可分的同文件修改不能混入自动提交。

具体子 Agent 创建/等待 API 由宿主提供。headless 的 `gantry loop claude|codex` 使用相同任务内核，每次 adapter 调用一个 fresh 客户端。

## 恢复

只依赖仓库工件：STATE 的阶段、TASKS 的完成状态、execution JSON 的预算/receipt、EXECUTION/PROGRESS 的诊断。先重验当前事实；可恢复问题在本次调用内继续，不要求用户反复调用 `/gantry:auto`。人工批准只适用于用户实际审阅的当前内容。

唯一例外：验收字段被误改时，只允许将当前任务的 verify/done/checks/preflight 精确恢复为传入的已保存 contract 原值；不修改 contract 控制记录、TASKS 完成状态或其他任务，不重新定义验收。
