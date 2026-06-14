---
name: gantry:resume
description: 断点恢复（新会话接力）
agent: auto
stage: auto
---

# /gantry:resume

新会话断点恢复。自动检测中断状态，组装最小恢复上下文，继续执行。

## 用法

- `/gantry:resume` — 自动检测并恢复
- `/gantry:resume <checkpoint-id>` — 解决指定 checkpoint 并继续

## 执行协议

### 1. 读取中断状态

读 `.gantry/planning/STATE.md`，提取：
- `currentStage` — 中断在哪个阶段
- `activeChange` — 哪个 change
- `currentTask` — 哪个 task（如果在 dev 阶段）
- `pauseReason` — 暂停原因

### 2. 判断中断类型并组装上下文

| 中断类型 | 判断条件 | 需要加载的文件 |
|---|---|---|
| **checkpoint 等待** | 有 pending checkpoint | checkpoint 文件 + 对应阶段产物 |
| **task 执行中断** | currentStage=dev 且 currentTask 非空 | TASK.md + PROGRESS.md + DESIGN.md |
| **阶段间中断** | currentStage 非 idle 且无 pending task | 当前阶段产物 + 下一阶段门禁检查 |

### 3. 检查 PROGRESS.md（task 中断时）

如果存在 `.gantry/specs/<change-id>/<task-id>-PROGRESS.md`：
1. 读「已排除的方案」— 确认接下来的计划不撞车
2. 读「当前正在做」— 确定续接点
3. 读「待确认的假设」— 如有未解决项，先向用户确认

如果不存在 PROGRESS.md 但 STATE 显示有中断 task：
- 检查 git log 最近提交，推断执行进度
- 检查 TASK.md 中该 task 的 verify 条件是否已满足

### 4. 恢复执行

- checkpoint 等待 → 显示 checkpoint 内容，等用户确认后推进
- task 中断 → 进入 dev 阶段，从断点续接
- 阶段间中断 → 检查门禁，满足则推进到下一阶段

### 5. 输出恢复摘要

```
恢复状态:
- Change: <id>
- 阶段: <stage>
- Task: <task-id>（如适用）
- 中断原因: <reason>
- 续接点: <description>
```
