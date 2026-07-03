---
name: gantry:next
description: 推进到下一阶段
agent: auto
stage: auto
---

# /gantry:next

推进管线到下一个阶段。自动检查门禁、分配 agent、加载阶段 prompt。

## 执行协议

1. 读取 `.gantry/planning/STATE.md` 获取当前阶段
2. 计算下一阶段（跳过 config 中 disabled 的阶段）
3. 检查门禁（前置工件是否存在）
4. 如果门禁通过：转换阶段，更新 STATE
5. 如果门禁失败：提示缺少的工件
6. 加载下一阶段的 phase prompt 并告知用户

## 门禁规则

| 目标阶段 | 前置条件 |
|----------|----------|
| requirement | `PROPOSAL.md` 存在（兼容期接受 `CHANGE.md`） |
| design | `SPEC.md` 存在（兼容期接受 `REQUIREMENT.md`） |
| task | DESIGN.md 存在 |
| dev | `TASKS.md` 存在（兼容期接受 `TASK.md`） |
| test | 所有 task status=done |
| review | TEST.md 存在 |
| integration | REVIEW.md 存在且通过 |
