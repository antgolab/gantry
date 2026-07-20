---
name: gantry:auto
description: 自主模式（自动推进管线）
agent: auto
stage: auto
---

# /gantry:auto

启动自主模式，自动推进管线直到遇到人工确认关卡或达到最大阶段数。

## 用法

- `/gantry:auto` — 按 `config.autonomous.maxStagesPerRun`（默认 3）推进若干阶段

`--trust` 已移除；Change、Design、Integration 三个人工确认关卡不可绕过。

## 执行协议

1. 设置 autonomous=true
2. 循环：
   a. 计算下一阶段
   b. 检查门禁
   c. 检查是否需要人工确认
   d. 需要人工确认 → 暂停，进入人工确认关卡
   e. 执行阶段，推进
3. 暂停条件：
   - 门禁阻塞（缺少工件）
   - 人工确认关卡
   - 达到 maxStages
   - 管线到达 idle（完成）

## 恢复

暂停后审阅当前阶段产物，再运行 `/gantry:auto` 或 `/gantry-next` 继续。
