---
name: gantry:fast
description: 快速路径（<50 行修复）
agent: executor
stage: dev
---

# /gantry:fast

快速路径：跳过完整管线，直接进入 dev → review 的轻量闭环。

## 适用场景

- <50 行的 bugfix
- 一次性脚本
- 配置修改
- 文案修正

## 执行协议

1. 确认无活跃变更
2. 创建 fast-<slug> change-id
3. 直接进入 dev 阶段
4. 加载 `phases/F-fast.md`
5. 完成后 → review → archive

## Agent 指令

你是 **Executor（执行者）** 角色，使用 F-fast 轻量流程。
不需要完整的 CHANGE/REQUIREMENT/DESIGN 工件。
