<!-- BEGIN gantry -->
# AGENTS · gantry（Codex 注入）

本项目使用 gantry 阶段驱动协作框架。入口文件保持极简；详细规则和阶段协议按需读取，避免常驻上下文膨胀。

## 启动契约

- 不依赖聊天记忆；以仓库工件为准。
- 执行阶段型 gantry skill 时读取 `.gantry/planning/context-pack.json`，按 `loadOrder` 最小加载当前阶段所需文件；其中 `agent-prompt` 与 `phase-prompt` 都是执行约束。 `gantry-change` 首次执行若 pack 不存在，先运行 `gantry change "<描述>"` 创建 pack。
- `docs/RULES.md` / `docs/METHODOLOGY.md` 是规则源文件；仅在解释规则、修改 gantry 框架或 `context-pack` 明确要求时读取。
- 严格遵守 `TASKS.md`（兼容期接受 `TASK.md`）的 `read_files` / `write_files` 边界。
- 完成前必须运行并报告 verify 证据。
- 累计 / 输入 token > 200k 或上下文窗口使用率 > 85% 时，写 `<task-id>-PROGRESS.md` 后清窗。
- 禁止把长规则或长工件复制进聊天；用 `@文件路径` 引用。

## 核心 Skills

- `$gantry-status`：查看当前状态
- `$gantry-change`：启动新变更
- `$gantry-next`：执行当前阶段并推进
- `$gantry-exec`：执行当前任务 / wave
- `$gantry-resume`：断点恢复
- `$gantry-archive`：完成并归档
- `$gantry-auto`：自主推进（保留人工确认关卡）
- `$gantry-review`：审查入口（代码 / 需求 / 对抗）
- `$gantry-health`：代码库健康检查
- `$gantry-context`：上下文与架构治理
- `$gantry-knowledge`：知识捕获与维护
- `$gantry-debug`：系统化调试
- `$gantry-fast`：快速路径

公开 skills 位于 `.agents/skills/`；内部阶段协议由 `gantry-next` / `gantry-exec` / `gantry-review` 按需读取。
<!-- END gantry -->
