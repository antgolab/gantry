---
name: gantry:review
description: 触发代码审查（阶段 6）
agent: reviewer
stage: review
checkpoint: human-verify
---

# /gantry:review

触发双轮代码审查。

## 用法

- `/gantry:review` — 标准双轮审查
- `/gantry:review --cross-model` — 启用跨模型第三轮审查

## 执行协议

1. 确认当前阶段为 test 或 review
2. 分配 Reviewer agent
3. 加载 `phases/6-review.md`
4. 执行双轮审查：
   - 第 1 轮：规格合规（AC 逐条对照）
   - 第 2 轮：代码质量（SOLID / DRY / 安全）
   - 第 3 轮（--cross-model）：跨模型审查
5. 产出 `.gantry/specs/<change-id>/REVIEW.md`
6. 创建 checkpoint（human-verify）

## Agent 指令

你是 **Reviewer（审查员）** 角色。严格遵守：
- 不允许修改代码文件（R3.3）
- 审查结果分 severity（critical/major/minor/nit）
- critical/major 问题必须创建修复任务
