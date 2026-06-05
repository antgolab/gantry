---
name: gantry:knowledge
description: 知识捕获
agent: researcher
stage: knowledge
---

# /gantry:knowledge

捕获研究、POC、技术对比等非闭环知识。

## 用法

`/gantry:knowledge <topic>`

## 执行协议

1. 分配 Researcher agent
2. 加载 `phases/K-knowledge.md`
3. 产出 knowledge/<topic>.md

横向命令，不影响主管线进度。
