---
name: gantry:archive
description: 归档维护命令（补归档 / 重新归档）
agent: integrator
stage: lateral
---

# /gantry:archive

把 `.specs/<change-id>/` 复制到 `.specs/_archive/<change-id>/`。`ship` 默认会自动归档；本命令用于补归档、重新归档或保留历史版本。

## 用法

- `/gantry:archive <change-id>` — 覆盖式归档（默认）
- `/gantry:archive <change-id> --keep-history` — 保留旧归档，新归档加版本号后缀（`<id>.v2`、`v3`...）

## 执行协议

调用 `gantry archive <change-id> [--keep-history]`。

CLI 行为：

1. 校验 change 不在活跃状态（`activeChange != id`）
2. 校验 `.specs/<change-id>/` 存在
3. 复制目录到 `.specs/_archive/<change-id>/`（不删除源）
4. 在归档目录追加 `ARCHIVE.md` 时间戳行（首次 / 多次归档累积）

## 与其他命令的关系

- `ship`：完成 change 并默认归档；传 `--no-archive` 时可用本命令补归档
- `adjust`：对当前活跃 change 打开或追加 `PATCH.md`，不直接读写归档
- `unarchive`：把归档恢复到 `.specs/<id>/`

## 何时运行

- ship 时跳过了归档，后来想长期保存 change 工件 → 补归档
- 需要继续已归档工件时 → 先 `unarchive` 恢复，再按需 `adjust`
- 项目期末批量整理 → 一次跑多个 archive
