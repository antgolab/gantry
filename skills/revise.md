---
name: gantry:revise
description: 历史兼容入口；新流程请使用 Gantry adjust
agent: planner
stage: current
---

# /gantry:revise

`revise` 已降级为兼容入口。持续修订的主路径是 `/gantry:adjust` / `gantry adjust "<发生了什么>"`，并通过 `.gantry/specs/<change-id>/PATCH.md` 做闭环。

## 用法

- `/gantry:revise "<触发原因>"` — 等价于 `/gantry:adjust "<触发原因>"`，仅支持当前活跃 change
- `/gantry:revise <当前活跃 change-id> "<触发原因>"` — 同上

## 不再推荐

- 不再创建 `Revision NN`
- 不再写入 `STATE.revisionOf / revisionId / revisionScope`
- 不再通过 revision scope 跳过 `design / review`
- 不再用于 idle 状态下修订历史 change

历史 change 需要继续工作时，先 `/gantry:unarchive <change-id>` 或重新激活 change，再使用 `/gantry:adjust "<发生了什么>"`。

## 新主路径

1. 调用 `gantry adjust "<发生了什么>"`
2. 在 `.gantry/specs/<change-id>/PATCH.md` 查看或补充「变更记录」和「必须更新」
3. 完成阶段工作后勾选对应检查项
4. `gantry next` / `gantry archive` 会检查 patch 是否闭环
