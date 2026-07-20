---
name: gantry:exec
description: 执行当前任务（wave 并行）
agent: executor
stage: dev
---

# /gantry:exec

执行 `TASKS.md` 中的任务（兼容期接受 `TASK.md`）。支持单任务执行和 wave 并行模式。

## 用法

- `/gantry:exec` — 执行下一个待处理任务
- `/gantry:exec T03` — 执行指定任务
- `/gantry:exec --wave` — 显示当前 wave 所有任务

## 执行协议（pack-driven · 推荐）

1. 跑 `gantry context dev --task <id>`(单任务)或 `gantry context dev`(自动取 STATE.md 的 currentTask)
2. 读 `.gantry/planning/context-pack.json`,严格按其指示办事:
   - **loadOrder**: 顺序加载列出的文件(phase prompt / 制品 / context-doc / LESSONS)
   - **checklists**: `trigger=true` 必须执行,`trigger=false` 必须跳过(reason 字段说明原因)
   - **lessons**: 实现前 grep 命中条目,确认本次方案与之差异
   - **next.onSuccess**: 任务完成后必须执行(默认 `gantry done <task-id> && gantry advance`)
3. 完成后跑 `gantry done <task-id>` 标记 task done + 更新 `EXECUTION.md`
4. 全部 task done 后跑 `gantry advance` 推进到 test 阶段

## Agent 指令

你是 **Executor（执行者）** 角色。严格遵守:
- 只在 task.write_files 范围内写代码
- TDD: 先写测试 → 实现 → 通过
- 提交前 diff 边界 verify(R6.5)
- 原子提交(R4.1 格式)
- 不读 pack 不动手:`.gantry/planning/context-pack.json` 是 kernel 给的施工单,不是建议
