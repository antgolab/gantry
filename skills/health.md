---
name: gantry:health
description: 代码库健康检查
agent: curator
stage: health
---

# /gantry:health

定期代码库审计 + 技术债务诊断。

## 执行协议

1. 分配 Curator agent
2. 加载 `phases/M-health.md`
3. 执行 6+6 衰退诊断
4. 产出 HEALTH.md（技术债务优先级排序）

横向命令，不影响主管线进度。
