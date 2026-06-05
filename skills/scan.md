---
name: gantry:scan
description: 情报扫描（brownfield 入场）
agent: researcher
stage: scan
---

# /gantry:scan

Brownfield 项目入场扫描。自动检测技术栈、命名规范、既有抽象。

## 执行协议

1. 分配 Researcher agent
2. 加载 `phases/I-intel-scan.md`
3. 扫描项目结构、配置文件、代码模式
4. 产出 CONTEXT.md（项目规则层）

横向命令，不影响主管线进度。
