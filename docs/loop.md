# Gantry 任务级 Ralph Loop

Ralph 的外层循环负责预约、隔离一次模型调用、实际验收和决定是否修复。模型在一次尝试内运行 TDD；它返回候选，完成状态由控制器根据当前内容上的真实命令结果写入。

```text
STATE 当前阶段 → 当前阶段 pack → 一次执行 → 门禁 → advance 一次
DEV 内部：ready task → 固定基线/contract并预约 → fresh executor
                         ↑                          ↓
                    新诊断 + 有限修复 ← 外层 verify/checks
                                                    ↓
                                      receipt → EXECUTION → TASKS
全部任务完成 → 组合检查 → 安全暂存后重验 → 一个 DEV commit → TEST
```

`src/loop/controller.mjs` 是 Node supervisor；`src/loop/loop.sh` 是兼容转接壳。它调用包内 CLI，避免全局不同版本混用。`dispatch-claude.sh` 每次调用 `claude -p`，`dispatch-codex.sh` 每次调用 `codex exec`，不 resume/continue。共享工作区只允许一个受控写者；wave 和 `[P]` 用来描述依赖/冲突，首版按 TASKS 顺序串行执行。

## 实际使用：增加价格舍入能力

在 full change 的 TASKS 中声明一个足够小的行为：

```xml
<task id="T01" status="pending">
  <name>金额保留两位小数</name>
  <read_files>src/money.mjs, tests/money.test.mjs</read_files>
  <write_files>src/money.mjs, tests/money.test.mjs</write_files>
  <preflight>node --version</preflight>
  <verify>node --test tests/money.test.mjs</verify>
  <checks>node --check src/money.mjs</checks>
  <done>输入 1.005 的输出符合 SPEC 中声明的舍入规则</done>
  <depends_on></depends_on>
</task>
```

先审阅 DESIGN，明确同意继续后，由宿主执行：

```bash
gantry advance --approve design   # 绑定实际设计内容，推进 task
# 完成TASKS并通过阶段自检后
gantry advance                    # 进入 dev
gantry loop codex                 # 或 claude；每次尝试一个fresh客户端
```

如果模型只打印“已完成”，外层仍运行 money.test.mjs。断言红灯则保留失败摘要，下次尝试读取具体诊断并新建 fresh context；第三次修复仍失败则停止。通过时 receipt 绑定 verify、任务边界和真实源码/索引内容。同 HEAD 下再修改 money.mjs 也会使 receipt 过期。后任务需要 T01 时，控制器先重验完成证据，不能只相信 status=done。

宿主 Agent 使用相同内核：

```bash
gantry dispatch --json              # 先固定基线/contract并预约一个ready task
gantry context dev --task T01 --json # 给fresh executor对应pack
# executor返回候选和实际验证报告，不改状态、不commit
gantry done T01 --json              # 控制器再次执行真实验收
# 下一task前重新dispatch；全部完成后
gantry advance                      # checkpoint、安全统一commit，再进入TEST
```

重复 dispatch 在已有预约未返回时阻塞，不因“查询次数”增加修复预算。上下文读取不等于预约。worker 不调用 done/dispatch/advance/approve/archive，不改 TASKS、EXECUTION、STATE、控制 JSON 或锁。宿主应冻结单任务 pack 并直接交给对应 worker，当前任务返回前不替换输入。headless controller 每次尝试把含 attemptId 的 pack 冻结在 `.gantry/loop/packs/`，adapter 支持 `<phase> [task-id] --pack <path>`，启动模型前机械校对 stage/task/attempt；不复用上一轮pack。

## 配置与有界执行

项目配置 `.gantry/planning/config.json`：

```json
{
  "ralph": {
    "executorTimeoutMs": 900000,
    "verifyTimeoutMs": 600000,
    "runTimeoutMs": 7200000,
    "killGraceMs": 5000,
    "checkpointCommands": ["npm run typecheck", "npm run lint"]
  }
}
```

时限必须为正整数，task contract 保存快照；改变已预约任务的验收配置会要求审阅调整。不要照抄不存在的 typecheck/lint，按项目实际组合检查配置；空列表时仍检查任务 verify/checks。`preflight` 与 `checks` 是逐行完整 shell 命令，逗号保持为命令参数。

| 循环 | 上限及事实来源 |
|---|---|
| task业务尝试 | 初次 0 + 三次修复 1/2/3，修复先持久化扣额度 |
| 明确瞬态传输故障 | 同预约内最多额外三次，1/2/4 秒退避，与业务额度分开 |
| 物理模型调用 | 每task最多 4×4=16 次，还受运行总deadline约束 |
| 单次executor / verify / run | 默认15分钟 / 10分钟 / 2小时 |
| 阶段步数 | `GANTRY_LOOP_MAX_STEPS`，默认40；task内部尝试不是阶段步数 |

网络故障分类只信 adapter 提供的明确事实；当前 Shell adapter 的未知非零退出保守停止，不把任意“error”文本或非零码自动认作429。runner 缺失、凭据缺失、需求歧义、越界和验收弱化需阻塞处理。Node TAP 可识别零用例/失败/跳过/todo，未知 runner 用例数为 `null`。弱化检测是机械启发式，测试语义和 TDD 真实性仍由 REVIEW 审查。

macOS/Linux 上每次受控调用建立 POSIX 进程组。超时或取消 TERM 整组，宽限后 KILL 并回收，leader 提前退出也检查后代。禁止主动 daemon 化/逃逸进程组；不能证明归属的旧进程会阻塞，不盲杀 PID。Windows headless 当前启动前拒绝；其他 CLI/light 能力不受此限制。

## 阶段与人工关卡

full 的 `loop-next` token 表示**当前待执行阶段**。词表保持 gantry-change/requirement/design/task/dev/test/review/integration/fast、done、blocked；显式 nextStep 与当前位置不符则 blocked。light 沿原 fast 出口门验证、升档或归档，不进入 full task-cycle。

Change 按既有澄清内容规则处理；Design/Integration 必须审阅后执行 `advance --approve <当前阶段>`。批准写入 fence.approvals 并绑定 changeId 与工件摘要；工件变化需重审。已有未批设计不会因 headless 重启被自动改写或批准。`--skip` 无法绕过人工批准/任务证据，批准 integration 不等于发布或归档。

`advance --json` stdout 仅输出结果对象，含 `pausedForApproval` / `reason` 等，日志走 stderr；controller 消费暂停而非忽略。普通推进只走一步。

## 恢复与提交

| 仓库事实 | 动作 |
|---|---|
| 已有候选但没有receipt | 先 done 重验；成功不再调模型 |
| receipt落盘但EXECUTION/TASKS未写 | 核对内容后幂等补齐 |
| TASKS done但receipt缺失/过期 | 不放行依赖；先重验或审阅迁移 |
| record损坏/版本未知 | 保留原文件并阻塞，不归零 |
| 未知旧锁/进程仍在 | 不开第二写者，核对所有权和清理事实 |
| 旧change未保存任务前基线 | 审阅任务范围及历史预算后迁移，不用当前候选冒充初始状态 |

最终 DEV checkpoint 在最终内容上重验过期任务并执行组合检查，成功命令可去重复用。安全暂存后索引内容会变化，因此还需在索引上重验，再产生一个 DEV commit。只加入本 change 的任务增量及 EXECUTION；已有暂存用户内容、无法分离的同文件改动会保留并阻塞自动提交。待提交记录与真实 Git commit/tree 核对，避免崩溃后重复提交。禁止整波 revert/reset 清理失败现场。

`execution/<task>.json` 保存预算/receipt，不复制 task done；TASKS 是完成状态源，STATE 是阶段源。日志在 `.gantry/loop/`，控制 JSON、锁、日志不进提交。安装新版后重新生成/安装 phase 和 skills，不自动覆盖正在运行任务的 contract。

## 输出与退出码

```bash
gantry loop claude --quiet  # -q，只输出摘要，详细输出落日志
gantry loop codex --verbose # -v，接受的兼容别名；默认流式输出
```

0=完成，2=阻塞/待批，3=运行预算或task修复耗尽，4=明确外部重试耗尽，5=无进展，64=用法/不支持平台，130/143=取消。done 验收失败为1，blocked为2；详细原因见 JSON kind。日志/metrics 是诊断，不是验收凭据。

相关实现：`src/lib/task-cycle.mjs`、`task-record.mjs`、`task-evidence.mjs`、`process-runner.mjs`；[自愈和预算](self-heal.md)、[阶段熔断](loop-guard.md)。
