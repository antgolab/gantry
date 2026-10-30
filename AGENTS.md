> 始终用中文与用户沟通。

## 思考原则

以**第一性原理**为基础，将问题拆解到最基本的事实，从事实向上推导。

- 动机不清晰 → 停下讨论，不假设
- 发现更短路径 → 直接说
- 遇到问题 → 追根因，不打补丁
- 只输出影响决策的内容


<!-- BEGIN gantry -->
# AGENTS · gantry（Codex 注入）

本项目使用 gantry 阶段驱动协作框架。入口文件保持极简；详细规则和阶段协议按需读取，避免常驻上下文膨胀。

## 启动契约

- 不依赖聊天记忆；以仓库工件为准。
- 执行阶段型 gantry skill 时读取 `.gantry/planning/context-pack.json`，按 `loadOrder` 最小加载当前阶段所需文件；其中 `agent-prompt` 与 `phase-prompt` 都是执行约束。 `gantry-change` 首次执行若 pack 不存在，先运行 `gantry change "<描述>"` 创建 pack。
- `docs/RULES.md` / `docs/METHODOLOGY.md` 是规则源文件；仅在解释规则、修改 gantry 框架或 `context-pack` 明确要求时读取。
- 按 `TASKS.md` 的 `read_files` / `write_files` 计划加载与实现；full DEV 文件列表差异记录提示，不代替实际验收或自动提交归属判断，保留用户内容。
- 完成前必须运行并报告 verify 证据。
- 累计 / 输入 token > 200k 或上下文窗口使用率 > 85% 时，写 `<task-id>-PROGRESS.md` 后清窗。
- 禁止把长规则或长工件复制进聊天；用 `@文件路径` 引用。

## 核心 Skills

日常骨架：
- `$gantry-change`：启动新变更
- `$gantry-next`：执行当前阶段并推进
- `$gantry-archive`：完成并归档

自动驾驶：
- `$gantry-auto`：多步自主推进（保留人工确认关卡）

状态类：
- `$gantry-status`：查看当前状态
- `$gantry-resume`：断点恢复
- `$gantry-adjust`：中途变化 → 打开 PATCH.md 闭环

审查与排障：
- `$gantry-review`：审查入口（代码 / 需求 / 对抗）
- `$gantry-debug`：系统化调试

维护：
- `$gantry-context`：上下文与架构治理（scan / architect / evolve / knowledge）
- `$gantry-health`：代码库健康检查
- `$gantry-unarchive`：从归档恢复 change

已内部化（不再作为用户命令入口）：
- `exec`：`$gantry-next` 到 dev 阶段自动触发
- `fast`：light 管线由 `gantry change --tier light --scope` 直接进入，无人工关卡
- `knowledge`：capture / curate 并入 `$gantry-context knowledge <sub>`

公开 skills 位于 `.agents/skills/`；内部阶段协议由 `gantry-next` 按需读取。
<!-- END gantry -->
