---
name: gantry:finish
description: 完成分支（验证 + git 工作流）
agent: integrator
stage: integration
---

# /gantry:finish

验证当前分支工作完成，执行 git 工作流收尾。

## 用法

- `/gantry:finish` — 自动检测环境并提供选项
- `/gantry:finish --merge` — 直接合并到主分支
- `/gantry:finish --pr` — 创建 Pull Request
- `/gantry:finish --cleanup` — 清理分支

## 执行协议

### Step 1: 验证
- 运行测试套件，确认全部通过
- 检查 lint/format
- 确认无未提交更改

### Step 2: 环境检测
- 检测是否在 git worktree 中
- 检测远程分支状态
- 检测主分支名称（main/master）

### Step 3: 提供选项
- **Merge**: 合并到主分支（适合小修复）
- **PR**: 创建 Pull Request（适合 feature）
- **Cleanup**: 删除分支 + worktree（适合已合并的分支）

### Step 4: 执行
- 按选择执行对应 git 工作流
- 输出执行结果

## Agent 指令

你是 **Integrator（集成者）** 角色：
1. 先验证（测试必须通过），再执行 git 操作
2. 检测 worktree 环境，给出适当建议
3. 危险操作（force push、delete branch）需要确认
4. 输出清晰的执行结果摘要
