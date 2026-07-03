---
name: gantry:adjust
description: 开发或测试过程中发现变化时，打开或追加当前 change 的 PATCH.md 闭环账本
agent: planner
stage: current
---

# /gantry:adjust

开发、测试、审查过程中发现新事实时使用。用户只描述发生了什么，流程把它写入当前 change 的单个 open patch。

## 用法

- `/gantry:adjust "<发生了什么>"` — 对当前活跃 change 打开或追加 `.gantry/specs/<change-id>/PATCH.md`

## 规则

- archive 前一个 change 最多只有一个 open patch。
- 多次 adjust 追加到同一个 `PATCH.md` 的「变更记录」。
- 新发现只能增加或保持「必须更新」检查项，不应静默删除旧检查项。
- 如果发现影响了更上游的工件，流程可回退到对应阶段继续执行。

## 执行协议

1. 读取 `.gantry/planning/STATE.md`，确认存在当前活跃 change。
2. 创建或追加 `.gantry/specs/<change-id>/PATCH.md`：
   - 记录本次新发现。
   - 根据描述推断必须更新项，例如 `SPEC.md`、`DESIGN.md`、`TASKS.md`、`DEV`、`TEST.md`（兼容期接受旧命名）。
   - 如影响上游阶段，更新 `.gantry/planning/STATE.md` 的当前阶段。
3. 后续阶段完成对应工作后，在 `PATCH.md` 勾选检查项
4. `/gantry:next` 会阻止未关闭的当前阶段 patch 项
5. `/gantry:archive` 会阻止未闭环的 open patch

## 用户心智

- 正常推进：`gantry next`
- 发现变化：`/gantry-adjust "..."`
- 完成受影响工作后勾选 `PATCH.md`
- 收尾：`gantry archive`
