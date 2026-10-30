# Gantry 验证分层

`npm test` 执行现有确定性测试及 `tests/evals/*.test.mjs`。`npm run verify` 检查构建分发完整性；它不能替代行为验证。`npm run test:evals` 只跑新执行型行为套件，不调用模型。

## 执行型评测

`tests/evals/behavior-harness.mjs` 创建独立临时 Git 仓库，通过真实 `install/change/dispatch/done/context` CLI 执行 fixture，采集进程退出码、stdout/stderr、实际 CLI 调用、源码快照、控制文件变化、TASKS 和有效 receipt。执行后清理临时仓库，不改开发者工作区。

确定性断言包括 `requiredFiles`、`unchangedFiles`、`requiredToolCalls`、`forbiddenToolCalls`、`requiredExitCode`、`taskReceiptValid` 和 `overblockGuard`。工具调用依据执行包装器或模型结构化事件，不能依据回答里提到的工具名。用户原有修改、越界候选、验收改写、失败/缺失命令、过期 receipt、无凭据依赖、只读检查和安全完成都有案例；控制文件排除在源码摘要外时仍可单独检查其字节变化。

失败分为产品行为 `fail`、基础设施 `infra-error`、未启用/未认证 `skip`。模型多次运行只有完成次数超过总尝试数的一半才有判定；其余为 `inconclusive`，不能冒充 PASS。报告同时记录多数通过、至少一次通过和每次都通过，单独统计安全工作被阻塞的 overblock。

## 可选真实模型执行

```bash
GANTRY_EVAL_ENGINE=claude GANTRY_EVAL_AUTHENTICATED=1 \
GANTRY_EVAL_TRIALS=3 GANTRY_EVAL_MAX_BUDGET_USD=0.5 \
npm run test:evals:model
```

先在本机正常认证 CLI，再设置 `GANTRY_EVAL_AUTHENTICATED=1`。不设置 engine 或认证确认时明确跳过，不调用模型。每个 scenario/trial 使用全新仓库。Claude 使用 `stream-json` 及 USD 上限；Codex 使用 `exec --json`，没有可移植的 USD 限额，必须额外显式设置 `GANTRY_EVAL_CODEX_BUDGET_ACK=1`，以 `GANTRY_EVAL_TIMEOUT_MS`（默认 60000）限制执行时长。TRIALS 为 1..10，默认 3；Claude USD 上限为每个 trial，不是整个套件总预算。

可选 `GANTRY_EVAL_OUT` 指定结果目录；默认创建系统临时目录。每次保留完整 `trace.jsonl`、进程输出/工具事实与 `result.json`，并向 `history.jsonl` 写 scenario、模型（客户端有提供时）、协议 hash、trial quorum、一致性和误阻塞统计。无模型版本事件时记录 null，不猜版本。

真实案例包括：限定文件修复并经 `dispatch/done` 独立验证；只读问题不启动任务/子 Agent。相同 fixture 使用 Claude/Codex 适配器；解析器有模拟两种真实 JSONL 格式的零 token 单测，实际供应商执行需显式开启。退出失败、超时、缺终止事件、错误终止或无法解析的轨迹均为基础设施错误，命令返回 0 不能单独认定完成。

默认 CI 只运行零 token 测试。协议、renderer 或模型升级时再选择运行模型评测；保留历史 hash 以区分协议修改与模型漂移。现有 `tests/run_stress_test.sh` 和 `tests/run_knowledge_prompt_test.sh` 继续作为补充压力/知识测试，不将其关键词断言提升为执行证据。
