---
name: gantry:init
description: 初始化 .planning/ 目录，启动 Gantry 协作
agent: null
stage: null
---

# /gantry:init

初始化当前项目的 Gantry 协作环境。

## 执行协议

1. 检查 `.planning/` 是否已存在
2. 如果不存在，运行 `node <gantry-root>/orchestrator/cli.mjs init`
3. 如果已存在，显示当前状态

## 产出

- `.planning/STATE.md` — 项目协作状态
- `.planning/ROADMAP.md` — 变更积压
- `.planning/config.json` — 管线配置

## 后续

运行 `/gantry:change` 启动第一个变更。
