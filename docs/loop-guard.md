# Gantry 阶段熔断与运行预算

`gantry advance` 入口内联 `preAdvanceLoopGuard`，纯判据在 `src/lib/loop-guard.mjs`；独立 `gantry loop-guard` 命令已删除。任务执行的时限、进程回收和修复额度由 Node controller/task-cycle 控制，不能用阶段重试包住耗尽的DEV任务。

| 优先级 | 条件 | reason |
|---|---|---|
| 1 | contextUsage.windowPercent >= 配置阈值 | context-window-exceeded |
| 2 | contextUsage.tokens > 配置阈值 | context-tokens-exceeded |
| 3 | stagesRun >= maxStages | max-stages-exceeded |

触发返回exit2，写fence.lastStageResult.blockedReason（已有非空原因不覆盖），后续loop-next返回blocked。contextUsage需宿主提供真实值，CLI不估算；缺数据时前两项不触发。

```json
{
  "loopGuard": { "contextPercent": 85, "contextTokens": 200000 }
}
```

默认阈值85%与200000 tokens。达到上下文阈值时写任务PROGRESS并交接，不复用过长失败上下文。stagesRun上限表示一次自主推进的阶段数，不能通过反复重置绕过任务预算。

## Node supervisor 的约束

- `GANTRY_LOOP_MAX_STEPS` 默认40，限制阶段步数；同一DEV token内的多个task/修复不是stuck。
- 无进展指advance未改变阶段/change等事实，返回5；不靠同token出现两次就停止。
- `.gantry/planning/config.json` 的ralph配置控制executorTimeoutMs、verifyTimeoutMs、runTimeoutMs、killGraceMs，默认15分钟、10分钟、2小时、5秒，必须为正整数。
- 一次任务初次执行 + 三次修复，额度先持久化；明确外部调用故障独立最多三次传输重试。无论从headless还是宿主入口恢复，都不能清零。
- 取消/超时先清理受控POSIX进程组，再验证/启动下一轮；无法证明旧组归属时blocked。Windows headless启动前拒绝。

`GANTRY_LOOP_DISPATCHER` 可为测试/嵌入替换adapter。CLI使用包内Node入口；旧GANTRY_BIN、LOOP_STUCK_LIMIT、GANTRY_LOOP_RETRIES、GANTRY_LOOP_BACKOFF不再控制DEV任务额度。配置时不要依赖这些旧变量重开修复。

## 处理阻塞

先检查实际reason和EXECUTION/PROGRESS/TaskRecord，处理根因。上下文达到上限时清窗接力；阶段上限时确认产物与本次run位置。人工关卡须审阅后显式 `advance --approve <当前阶段>`，普通重启不批准。修复耗尽需要审阅新的任务修订并保留旧账，不能仅清fence。

确认具体阻塞已处理后才清理对应fence原因；它不是删除控制记录或重置预算的许可。未知锁/旧执行者保留现场核对，不盲杀或自动删除。

## 输出

默认流式转发adapter输出，并写 `.gantry/loop/last-dispatch.log`、`last-advance.log` 和metrics.jsonl。`--quiet/-q`只输出摘要；`--verbose/-v`是默认输出的兼容别名。

阶段日志用于诊断，receipt才是内容验收证据。返回码及完整运行示例见 [loop.md](loop.md)。
