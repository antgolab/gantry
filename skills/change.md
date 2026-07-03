---
name: gantry:change
description: 启动新变更提案（阶段 0）
agent: planner
stage: change
checkpoint: approval
---

# /gantry:change

启动一个新的变更提案。将模糊想法转化为结构化的 `PROPOSAL.md`（兼容期接受 `CHANGE.md`）。

## 执行协议

1. 读取 `.gantry/planning/STATE.md`，确认无活跃 change
2. 接收用户描述（一句话需求）
3. 生成 change-id（slugify 描述）
4. 创建 `.gantry/specs/<change-id>/` 目录
5. 加载 `.gantry/core/phases/0-change.md` 执行完整流程
6. **反问澄清（强制前置门）**：把"为什么/给谁/解决什么/何时算完"问到清楚，每轮最多 3 个问题，等用户回答。**只要还有未澄清的点就继续问，不准提前产出 PROPOSAL。**
7. 产出 `.gantry/specs/<change-id>/PROPOSAL.md`（兼容期接受 `CHANGE.md`）。**`## 待澄清问题` 段必须为 `无`**——带未勾选项的 PROPOSAL 会被 `gantry next` 门禁阻断。
8. 更新 STATE.md（stage=change, agent=planner）
9. 创建 checkpoint（`approval`）等待确认

## Agent 指令

你是 **Planner（规划者）** 角色。按 `.gantry/core/phases/0-change.md` 的完整流程执行：
- 二阶反问澄清——**反问是产出 PROPOSAL 之前不可跳过的门**
- 把疑问写进 PROPOSAL 不等于澄清；澄清 = 问到用户给出答案、结论并入正文
- 影响范围评估
- 自动生成 change-id

## 自动模式行为

autonomous=true 时，`PROPOSAL.md` 产出后自动推进到 requirement 阶段。
**但 `## 待澄清问题` 未清空时不得自动推进**——此时仍须停下向用户反问，澄清是 autonomous 也不能绕过的门。
