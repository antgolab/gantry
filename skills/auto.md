---
name: gantry:auto
description: 自主模式（自动推进管线）
agent: auto
stage: auto
---

# /gantry:auto

启动自主模式，自动推进管线直到遇到人工确认关卡或达到最大阶段数。DEV 阶段由当前 Agent 只负责编排，每个 wave 创建一个新子 Agent。

## 用法

- `/gantry:auto` — 按 `config.autonomous.maxStagesPerRun`（默认 3）推进若干阶段

`--trust` 已移除；Change、Design、Integration 三个人工确认关卡不可绕过。

## 执行协议

1. 设置 autonomous=true
2. 非 DEV 阶段循环：
   a. 计算下一阶段
   b. 检查门禁
   c. 检查是否需要人工确认
   d. 需要人工确认 → 暂停，进入人工确认关卡
   e. 执行阶段，推进
3. 进入 DEV 时执行“连续任务调度协议”，全部 task 完成后再推进 TEST。
4. 暂停条件：
   - 门禁阻塞（缺少工件）
   - 人工确认关卡
   - 达到 maxStages
   - 管线到达 idle（完成）

## DEV wave 调度协议

主 Agent 默认是 orchestrator，除 `fallback_main` 降级分支外，**禁止直接修改 task 代码**：

1. 运行 `gantry dispatch --json`。
2. 返回 `{"status":"all_done"}`：运行 `gantry advance`，然后继续阶段循环。
3. 返回 `{"status":"fallback_main","waveId":1,"taskIds":["T01"]}`：停止为该 wave 创建子 Agent，由主 Agent 在当前上下文接管 `taskIds`。对每个 task 仍须先运行 `gantry context dev --task <id>` 并重新读取 `$gantry-exec` 与 context pack，逐 task 完成 TDD、verify、原子提交和 `gantry done <task-id>`；任一 task 失败立即停止并保留证据。接管完成后重新 dispatch。
4. 返回 `{"status":"dispatched","waveId":1,"taskIds":["T01","T02"]}`：为该 wave 创建一个新子 Agent，并把 `waveId`、有序 `taskIds` 和共享工作区约束交给它。
5. 每次只运行一个 wave 子 Agent；等待它完全结束后才继续。子 Agent 必须在 wave 内逐个 task 执行：
   - 对每个 task 先运行 `gantry context dev --task <id>`，再重新读取 `$gantry-exec` 协议与当前 context pack；禁止一次加载整个 wave 的实现上下文。
   - 严格遵守当前 task 的文件边界，完成 TDD、verify、原子提交和 `gantry done <task-id>` 后，才切换到下一个 task。
   - 任一 task 失败立即停止 wave，不得跳过失败任务继续执行后续 task。
   - wave 子 Agent 是叶子执行者，禁止在内部创建、恢复或委派其他子 Agent；它直接完成分配的 task。
   - 子 Agent 禁止执行 `gantry advance`，阶段推进只属于 orchestrator。
   - 共享工作区中不得撤销或覆盖其他人的既有修改。
6. 子 Agent 返回后重新运行 `gantry dispatch --json` 验证仓库事实；同一 canonical wave 仍有 pending task 时，CLI 机械递增 `STATE.retries`，并返回相同 `waveId` 和剩余 `taskIds`。
7. wave 失败或仍有 pending task：记录失败，在重试额度内为该 wave 的剩余任务创建**新的子 Agent**；禁止复用失败子 Agent 的上下文。重试上限由 `gantry dispatch` 按 `autonomous.maxRetries` 机械执行；耗尽后返回 `fallback_main`，由主 Agent 接管，不因子 Agent 持续失败而等待人工介入。
8. 禁止同时启动多个 wave 子 Agent。子 Agent 创建次数正常情况下等于 wave 数，而不是 task 数。

具体如何创建和等待子 Agent，由各运行时生成的适配协议规定。

## 恢复

暂停后审阅当前阶段产物，再运行 `/gantry:auto` 或 `/gantry-next` 继续。
