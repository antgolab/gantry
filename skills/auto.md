---
name: gantry:auto
description: 自主模式（自动推进管线）
agent: auto
stage: auto
---

# /gantry:auto

启动自主模式，自动推进管线直到遇到人工确认关卡或达到最大阶段数。DEV 阶段由当前 Agent 只负责编排，同一 wave 的每个 task 各创建一个新子 Agent 并发执行。

## 用法

- `/gantry:auto` — 按 `config.autonomous.maxStagesPerRun`（默认 3）推进若干阶段

`--trust` 已移除；Change、Design、Integration 三个人工确认关卡不可绕过——但这三关**只存在于 full 管线**。light 管线无任何人工关卡：它在 `fast` 里由 `gantry advance` 出口门自动收敛（守卫命中则自动升档 `full@change`，否则自动归档），`/gantry:auto` 不需要为它暂停。

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
2. 返回 `{"status":"all_done"}`：按 `4-dev.md` § 0.5 做 DEV 末统一 commit，再运行 `gantry advance`，然后继续阶段循环。
3. 返回 `{"status":"fallback_main","waveId":1,"taskIds":["T01"]}`：停止为该 wave 创建子 Agent，由主 Agent 在当前上下文接管 `taskIds`。对每个 task 仍须先运行 `gantry context dev --task <id>` 并重新读取 `.gantry/core/phases/4-dev.md`「单任务执行」与 context pack，逐 task 完成 TDD、verify 和 `gantry done <task-id>`（不单独 commit，R4.1）；任一 task 失败立即停止并保留证据。接管完成后重新 dispatch。
4. 返回 `{"status":"dispatched","waveId":1,"taskIds":["T01","T02"]}`：按 taskIds 顺序**串行**运行 `gantry context dev --task <id> --json`，分别保存每个 task 的 pack。`.gantry/planning/context-pack.json` 是单文件、会被后一次覆盖，所以 pack 只通过 prompt 交给子 Agent。
5. 在同一条消息里为每个 task 各创建一个新子 Agent 并发执行，每个子 Agent 只拿到 `waveId`、自己的 `taskId`、对应 pack 和共享工作区约束：
   - 只执行自己的 task，只认 prompt 里的 pack，不读 `context-pack.json`；严格遵守该 task 的文件边界，完成 TDD 和 verify。
   - 不 commit，不运行 `gantry done`，不改 `TASKS.md` / `EXECUTION.md`；pack 的 `next.onSuccess` 由 orchestrator 代为执行。执行记录和微复盘 `problem / cause / next` 写进返回报告。
   - 子 Agent 是叶子执行者，禁止在内部创建、恢复或委派其他子 Agent。
   - 子 Agent 禁止执行 `gantry advance`，阶段推进只属于 orchestrator。
   - 共享工作区中不得撤销或覆盖其他人的既有修改。
6. 同步等待本 wave 全部子 Agent 返回后，按 `4-dev.md` § 0.3 做 wave checkpoint：绿则按 taskIds 顺序串行运行成功 task 的 `gantry done <task-id>`，并把返回报告填进 `EXECUTION.md` 对应 task 段；红则整波 revert 后重跑。
7. 重新运行 `gantry dispatch --json` 验证仓库事实；同一 canonical wave 仍有 pending task 时，CLI 机械递增 `STATE.retries`，并返回相同 `waveId` 和剩余 `taskIds`。在重试额度内为剩余 task 创建**新的子 Agent**，禁止复用失败子 Agent 的上下文。重试上限由 `gantry dispatch` 按 `autonomous.maxRetries` 机械执行；耗尽后返回 `fallback_main`，由主 Agent 接管，不因子 Agent 持续失败而等待人工介入。
8. 当前 wave 的子 Agent 未全部返回前，不得启动下一个 wave。子 Agent 创建次数正常情况下等于 task 数。

具体如何创建和等待子 Agent，由各运行时生成的适配协议规定。

## 恢复

暂停后审阅当前阶段产物，再运行 `/gantry:auto` 或 `/gantry-next` 继续。
