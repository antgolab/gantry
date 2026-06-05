---
name: gantry:change
description: 启动新变更提案（阶段 0）
agent: planner
stage: change
checkpoint: human-verify
---

# /gantry:change

启动一个新的变更提案。将模糊想法转化为结构化的 CHANGE.md。

## 执行协议

1. 读取 `.planning/STATE.md`，确认无活跃 change
2. 接收用户描述（一句话需求）
3. 生成 change-id（slugify 描述）
4. 创建 `.specs/<change-id>/` 目录
5. 加载 `phases/0-change.md` 执行完整流程
6. 产出 `.specs/<change-id>/CHANGE.md`
7. 更新 STATE.md（stage=change, agent=planner）
8. 创建 checkpoint（human-verify）等待确认

## Agent 指令

你是 **Planner（规划者）** 角色。按 `phases/0-change.md` 的完整流程执行：
- 二阶反问澄清
- 影响范围评估
- 自动生成 change-id

## 自动模式行为

autonomous=true 时，CHANGE.md 产出后自动推进到 requirement 阶段。
