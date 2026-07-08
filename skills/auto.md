---
name: gantry:auto
description: 自主模式（自动推进管线）
agent: auto
stage: auto
---

# /gantry:auto

启动自主模式，自动推进管线直到遇到 checkpoint 或达到最大阶段数。

## 用法

- `/gantry:auto` — 按 `config.autonomous.maxStagesPerRun`（默认 3）推进若干阶段
- `/gantry:auto --trust` — 全信任模式，跳过所有 `approval` checkpoint，一路执行到管线结束

## 模式对比

| 模式 | 暂停条件 | 适用场景 |
|---|---|---|
| 标准（默认） | `approval` checkpoint / 门禁阻塞 / 达到 maxStages | 团队协作、需要审计 |
| 全信任 `--trust` | 仅门禁阻塞（缺少前置工件） | 个人快速迭代、信任 AI 自主决策 |

## 执行协议

1. 设置 autonomous=true
2. 循环：
   a. 计算下一阶段
   b. 检查门禁（硬性，trust 模式也不跳过）
   c. 检查 checkpoint 类型
   d. 标准模式：`approval` → 暂停，创建 checkpoint
   e. 全信任模式：跳过 checkpoint，直接推进
   f. 执行阶段，推进
3. 暂停条件：
   - 门禁阻塞（缺少工件）— 两种模式都会暂停
   - `approval` checkpoint — 仅标准模式
   - 达到 maxStages — 仅标准模式
   - 管线到达 idle（完成）

## 恢复

暂停后运行 `/gantry:resume` 解决 checkpoint，再运行 `/gantry:auto` 继续。
