---
name: gantry:archive
description: 完成当前 change 收尾并归档
agent: integrator
stage: integration
checkpoint: approval
---

# /gantry:archive

完成当前活跃 change 的生命周期：验证收尾条件、复制归档到 `.gantry/specs/_archive/<change-id>/`，然后把 STATE 重置为 idle。

## 用法

- `/gantry:archive` — 收尾并覆盖式归档当前活跃 change
- `/gantry:archive --force` — 跳过阶段检查 + Patch 闭环检查强制收尾
- `/gantry:archive --keep-history` — 保留旧归档，新归档加版本号后缀（`<id>.v2`、`v3`...）

## 执行协议

调用 `gantry archive [--force] [--keep-history]`。

CLI 行为：

1. 校验存在活跃 change
2. 默认要求当前阶段为 integration（`--force` 可跳过）
3. 检查 `PATCH.md` 闭环（`--force` 可跳过）
4. 输出生命周期报告
5. 复制 `.gantry/specs/<change-id>/` 到 `.gantry/specs/_archive/<change-id>/`
6. 在归档目录追加 `ARCHIVE.md` 时间戳行
7. 重置 STATE 为 idle

## 与其他命令的关系

- `adjust`：对当前活跃 change 打开或追加 `PATCH.md`，不直接读写归档
- `unarchive`：把归档恢复到 `.gantry/specs/<id>/` 并重新激活 change

## 何时运行

- 当前需求已经完成，需要切换到下一个需求
- 当前需求需要中止但保留工件，用 `--force` 强制收尾
- 已恢复的历史需求再次完成，需要重新归档
