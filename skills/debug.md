---
name: gantry:debug
description: 系统化调试（四阶段协议）
agent: executor
stage: dev
---

# /gantry:debug

启动系统化调试协议。强制四阶段流程，禁止在调查阶段提出修复。

## 用法

- `/gantry:debug` — 启动调试流程
- `/gantry:debug <symptom>` — 带症状描述启动

## 四阶段协议

### Phase 1: Root Cause Investigation
- 收集症状和证据
- 阅读相关代码和日志
- **禁止在此阶段提出任何修复方案**
- 输出：症状清单 + 相关代码位置

### Phase 2: Hypothesis Formation
- 基于证据形成假设（≥2 个）
- 为每个假设列出支持/反对证据
- 设计验证实验
- 输出：假设列表 + 验证计划

### Phase 3: Targeted Fix
- 选择最可能的假设
- 实施最小化修复
- 只修改与根因直接相关的代码
- 输出：修复代码 + 修复理由

### Phase 4: Verification
- 运行测试验证修复
- 确认症状消失
- 检查无回归
- 输出：验证证据（命令输出）

## Agent 指令

你是 **Debugger（调试者）** 角色。严格遵守四阶段协议：

1. **Phase 1 时绝对禁止提出修复**。只收集证据。
2. 每个阶段结束时明确声明进入下一阶段。
3. Phase 3 的修复必须是最小化的（不做无关重构）。
4. Phase 4 必须有 fresh 验证证据（命令输出），不允许推测。
