# Gantry 任务级 Ralph Loop

Ralph 的外层循环负责预约、隔离一次模型调用、实际验收和决定是否修复。模型在一次尝试内循环调查、修复并运行 verify/checks，直至通过或遇到具体外部阻塞；缺包或 API 不匹配应先核对并实测兼容依赖组合，不能仅报告失败就返回。模型返回候选，完成状态由控制器根据当前内容上的真实命令结果写入。

```text
STATE 当前阶段 → 当前阶段 pack → 一次执行 → 门禁 → advance 一次
DEV 内部：ready task → 固定基线/contract并预约 → fresh executor
                         ↑                          ↓
                    新诊断 + 有限修复 ← 外层 verify/checks
                                                    ↓
                                      receipt → EXECUTION → TASKS
全部任务完成 → 组合检查 → 安全暂存后重验 → 一个 DEV commit → TEST
```

`src/loop/controller.mjs` 是 Node supervisor；`src/loop/loop.sh` 是兼容转接壳。它调用包内 CLI，避免全局不同版本混用。`dispatch-claude.sh` 每次调用 `claude -p`，`dispatch-codex.sh` 每次调用 `codex exec`，不 resume/continue。共享工作区只允许一个受控写者；wave 和 `[P]` 用来描述依赖/冲突，当前按 TASKS 顺序串行执行。

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

即使模型只打印“已完成”，外层仍会运行 money.test.mjs。断言失败则保留失败摘要，下次尝试读取具体诊断并新建 fresh context；修复预算耗尽后停止。通过时 receipt 绑定 verify、任务边界和真实源码/索引内容。同 HEAD 下再修改 money.mjs 也会使 receipt 过期。后任务需要 T01 时，控制器先重验完成证据，不只相信 `status=done`。

宿主 Agent 使用相同内核：

```bash
gantry dispatch --json               # 固定基线/contract并预约一个ready task
gantry context dev --task T01 --json # 给fresh executor对应pack
# executor返回候选和实际验证报告，不改状态、不commit
gantry done T01 --json               # 控制器再次执行真实验收
# 下一task前重新dispatch；全部完成后
gantry advance                       # checkpoint、安全统一commit，再进入TEST
```

重复 dispatch 在已有预约未返回时阻塞，不因“查询次数”增加修复预算。上下文读取不等于预约。worker 不调用 done/dispatch/advance/approve/archive，不改 TASKS、EXECUTION、STATE、控制 JSON 或锁。宿主应冻结单任务 pack 并直接交给对应 worker，当前任务返回前不替换输入。headless controller 每次尝试把含 attemptId 的 pack 冻结在 `.gantry/loop/packs/`，adapter 支持 `<phase> [task-id] --pack <path>`，启动模型前机械校对 stage/task/attempt，不复用上一轮 pack。

## 配置与有界执行

项目配置 `.gantry/planning/config.json`：

```json
{
  "ralph": {
    "maxRepairs": 3,
    "executorTimeoutMs": 900000,
    "verifyTimeoutMs": 600000,
    "runTimeoutMs": 7200000,
    "killGraceMs": 5000,
    "checkpointCommands": ["npm run typecheck", "npm run lint"]
  }
}
```

时限必须为正整数。运行参数在每次执行、修复和验证前读取最新配置，不参与任务验收摘要；旧快照自动兼容，不要求 adjust、不重置预算或原始基线。运行中的进程沿用启动时的时限，下一执行边界应用新值；loop 总时限始终从本次启动计时，刷新配置不重置计时。配置文件的实质变化使证据失效并自动重验，不算任务越界；仅格式和键顺序变化不影响证据。任务 verify 和完成标准等验收内容仍受契约保护；`read_files` / `write_files` 是计划提示，变更列表不阻断。不要照抄不存在的 typecheck/lint，应按项目实际组合检查配置；空列表时仍检查任务 verify/checks。`preflight` 与 `checks` 是逐行完整 shell 命令，逗号保持为命令参数。

| 循环 | 上限及事实来源 |
|---|---|
| task 业务尝试 | 初次 + `ralph.maxRepairs` 次修复（默认 3），修复先持久化扣额度 |
| 明确瞬态传输故障 | 同预约内最多额外三次，1/2/4 秒退避，与业务额度分开 |
| 物理模型调用 | 每 task 最多 `(1 + maxRepairs) × 4` 次（默认 16），还受运行总 deadline 约束 |
| 单次 executor / verify / run | 默认 15 分钟 / 10 分钟 / 2 小时 |
| 阶段步数 | `GANTRY_LOOP_MAX_STEPS`，默认 40；task 内部尝试不是阶段步数 |

网络故障分类只信 adapter 提供的明确事实；Shell adapter 的安全非零退出进入有界修复，不把任意“error”文本或非零码自动认作 429。runner/环境缺失和验收弱化交 agent 修复；需要用户提供的新凭据或需求决策仍记录明确事实，不自行批准；计划范围外文件只提示具体路径。Node TAP 可识别零用例/失败/跳过/todo，未知 runner 用例数为 `null`。弱化检测是机械启发式，测试语义和 TDD 真实性仍由 REVIEW 审查。

macOS/Linux 上每次受控调用建立 POSIX 进程组。超时或取消时 TERM 整组，宽限后 KILL 并回收，leader 提前退出也检查后代。禁止主动 daemon 化/逃逸进程组；不能证明归属的旧进程会阻塞，不盲杀 PID。Windows headless 当前启动前拒绝；其他 CLI/light 能力不受此限制。

## 阶段与人工关卡

full 的 `loop-next` token 表示**当前待执行阶段**。词表保持 gantry-change/requirement/design/task/dev/test/review/integration/fast、done、blocked；显式 nextStep 与当前位置不符则 blocked。light 沿原 fast 出口门验证、升档或归档，不进入 full task-cycle。

Change 按既有澄清内容规则处理；Design/Integration 必须审阅后执行 `advance --approve <当前阶段>`。批准写入 fence.approvals 并绑定 changeId 与工件摘要；工件变化需重审。已有未批设计不会因 headless 重启被自动改写或批准。`--skip` 无法绕过人工批准/任务证据，批准 integration 不等于发布或归档。

`gantry loop --auto-approve` 是显式的双模式开关：仅无人值守 loop 环境有效，遇到 change/design/integration 硬锁时替人写入内容绑定批准并继续推进，留痕到 `.gantry/loop/metrics.jsonl`。它**只**消掉人工批准这一层，不自动跳过 hard 门禁；交互式 `gantry advance` / `auto` 仍保留人工关卡。

`advance --json` stdout 仅输出结果对象，含 `pausedForApproval` / `reason` 等，日志走 stderr；controller 消费暂停而非忽略。普通推进只走一步。

## 失败诊断与自动修复

task-cycle 自动持久化预约、候选和失败事实。默认配置下，一次任务为初次执行 + 三次修复；第三次修复仍失败即耗尽，不启动第四次，也不通过整段 DEV 重派清零。任务接口返回 `failure.category` 和 `recovery`，分类包括 task-defect、dependency-invalid、environment-failure、flaky-test、blocked-human。只修归属任务，保留用户改动、其他已完成成果和已消费预算，不整波回退。

- 可恢复的测试失败、环境缺失、验收契约漂移、验证过程修改内容和安全返回的客户端失败进入原任务修复预算；每次修复后重新执行真实验收。
- 契约漂移只能恢复原验收，不能降低标准。测试删除、断言减少等明确弱化仍阻断；配置变化本身不等于弱化，变化后实际重验即可。
- 零测试、没有通过用例或真实失败不能记成功。整测试文件删除仍列出具体路径并要求审阅。
- 明确的 429/连接中断等传输故障可以在同一预约内额外重试，不增加业务修复序号；未知非零不能这样重试。传输失败可能留下有用代码，因此仍先验证候选。
- 相同内容由成功变失败会记录 flaky-test。独立 `gantry done <id> --recheck --json` 用于显式复验并保留不稳定性诊断；自动 loop 是否继续修复由当前门禁恢复策略和预算决定，不能用重跑掩盖确定性失败。

`gantry heal` 保留人工可读诊断入口；它不预约模型调用、不修改验收 contract，也不是预算真值：

```bash
gantry heal T02 --reason "舍入边界断言失败" \
  --command "node --test tests/money.test.mjs" \
  --stderr "expected 1.01 got 1.00"
gantry heal --check T02
```

手动记录追加到 `EXECUTION.md` 的 `## Self-Heal Log`，保留 at/reason/command/stderr；reason 单行截 200 字符，stderr 限 8KB。记录次数不等于已启动修复次数。`heal --check` 依据持久 TaskRecord 查询额度；已预约的最后一次修复仍可返回并成功，只有该次返回且验证失败后才判耗尽。损坏或未知版本记录保持 blocked，不覆盖、不归零。

需求、AC、范围变化走 adjust/PATCH；代码修复走 task-cycle，二者不能互相替代。清除 fence 只处理阻塞标志，不重置 repairsUsed、预约和历史，不能凭清除 fence 重开修复。

## 恢复与提交

| 仓库事实 | 动作 |
|---|---|
| 已有候选但没有 receipt | 先 done 重验；成功不再调模型 |
| receipt 落盘但 EXECUTION/TASKS 未写 | 核对内容后幂等补齐 |
| TASKS done 但 receipt 缺失/过期 | 不放行依赖；先重验或审阅迁移 |
| record 损坏/版本未知 | 保留原文件并阻塞，不归零 |
| 未知旧锁/进程仍在 | 不开第二写者，核对所有权和清理事实 |
| 旧 change 未保存任务前基线 | 审阅任务范围及历史预算后迁移，不用当前候选冒充初始状态 |

最终 DEV checkpoint 在最终内容上重验过期任务并执行组合检查，成功命令可去重复用。安全暂存后索引内容会变化，因此还需在索引上重验，再产生一个 DEV commit。只加入本 change 的任务增量及 EXECUTION；已有暂存用户内容、无法分离的同文件改动会保留并阻塞自动提交。待提交记录与真实 Git commit/tree 核对，避免崩溃后重复提交。禁止整波 revert/reset 清理失败现场。

full DEV 不因 `out-of-scope` 停止：receipt / done JSON 的 `scope` 列出 changedFiles 与 outOfScope，控制台显示具体文件，EXECUTION 记录提示。自动提交不会把来源不明的额外文件加入提交；light 的 scope 升档独立存在。

`execution/<task>.json` 保存预算/receipt，不复制 task done；TASKS 是完成状态源，STATE 是阶段源。日志在 `.gantry/loop/`，控制 JSON、锁、日志不进提交。安装新版后重新生成/安装 phase 和 skills，不自动覆盖正在运行任务的 contract。

## 上下文与阶段熔断

`gantry advance` 入口内联 `preAdvanceLoopGuard`，纯判据在 `src/lib/loop-guard.mjs`；没有独立的 `gantry loop-guard` 命令。任务执行的时限、进程回收和修复额度由 Node controller/task-cycle 控制，不能用阶段重试包住已耗尽的 DEV 任务。

| 优先级 | 条件 | reason |
|---|---|---|
| 1 | `contextUsage.windowPercent` ≥ 配置阈值 | `context-window-exceeded` |
| 2 | `contextUsage.tokens` > 配置阈值 | `context-tokens-exceeded` |
| 3 | `stagesRun` ≥ `maxStages` | `max-stages-exceeded` |

```json
{
  "loopGuard": { "contextPercent": 85, "contextTokens": 200000 }
}
```

默认上下文阈值为 85% 与 200000 tokens。contextUsage 需宿主提供真实值，CLI 不估算；缺数据时前两项不触发。达到上下文阈值时写任务 PROGRESS 并交接，不复用过长失败上下文。`maxStages` 表示一次自主推进的阶段数，`GANTRY_LOOP_MAX_STEPS` 默认 40，二者都不能通过反复重置绕过任务预算。

触发后返回 exit 2，写 `fence.lastStageResult.blockedReason`；已有非空原因不覆盖。先检查实际 reason 和 EXECUTION/PROGRESS/TaskRecord，处理根因。确认具体阻塞已处理后才清理对应 fence 原因；它不是删除控制记录或重置预算的许可。未知锁/旧执行者保留现场核对，不盲杀或自动删除。

无进展指 advance 未改变阶段/change 等事实，返回 5；不靠同 token 出现两次就停止。新启动的 headless loop 会重新检查当前任务和阶段门禁，不被历史 blockedReason 永久拦住；预算、批准、锁与真实验收仍检查，历史诊断不清零。`GANTRY_LOOP_DISPATCHER` 可为测试/嵌入替换 adapter。

## 输出与退出码

```bash
gantry loop claude            # 默认：控制台只打进度，完整日志落loop.log
gantry loop claude --quiet    # -q，每步一行机器可读摘要
gantry loop claude --verbose  # -v，额外流式输出模型dispatch全量
```

完整日志写唯一临时目录下的 `loop.log`；`mkdtemp` 保证目录唯一，控制台打印完整路径，`GANTRY_LOOP_LOG_DIR` 可显式指定固定位置。模型 dispatch 流同时写 `.gantry/loop/last-dispatch.log`（每次覆盖），advance 输出写 `.gantry/loop/last-advance.log`；`metrics.jsonl` 追加每步机器指标。日志/metrics 是诊断，不是验收凭据。

| 退出码 | 含义 |
|---|---|
| 0 | 完成 |
| 1 | 独立 done 验收失败 |
| 2 | 阻塞/待批 |
| 3 | 运行预算或 task 修复耗尽 |
| 4 | 明确外部重试耗尽 |
| 5 | 无进展 |
| 64 | 用法/不支持平台 |
| 130/143 | 取消 |

详细原因见 JSON kind。

## AC 执行证据

integration 的静态 `checkAcCoverage` 检查 SPEC AC 编号是否映射到 `.gantry/loop/test-commands.yml` 的 cmd/covers；`gantry install` 只铺注释模板，不覆盖已有文件。`covers` 只描述命令与 AC 的映射，不能证明命令执行通过，独立 `ac-gate` CLI 已折叠到门禁。

TEST 先补齐映射，再统一运行：

```bash
gantry verify-ac --json
```

CLI 在单写者锁内运行映射命令，逐条记录退出码、stdout/stderr、可识别测试计数、取消/超时与清理状态。输入绑定实际源码、暂存区、非忽略新文件、SPEC/TASKS 和验证配置；仅 HEAD 相同不足以复用证据。验证命令改变源码时本次失败。默认单命令期限十分钟，进程清理沿用有界执行器。

结果保存到当前 change 的 `execution/ac-evidence.json`，由 integration 和 archive 的只读 gate 消费。TEST/REVIEW/UAT/JOURNEY-VERIFY 是输出，变更报告本身不会使自动命令证据失效；手动观察引用的附件单独绑定字节摘要。不要把日志、报告当源码输入，避免证据写入导致自身过期。

人工或跨服务观察写 JSON 后记录：

```json
{
  "acId": "AC-1",
  "kind": "manual",
  "steps": "保存后刷新，再 GET 读取",
  "actual": "刷新后仍返回保存的值",
  "result": "pass",
  "evidencePath": ".gantry/specs/my-change/UAT.md"
}
```

```bash
gantry verify-ac --observation observation.json --json
```

`kind` 可以是 manual/journey；result 为 pass/fail/caveat。必须有真实步骤、实际结果及仓库内附件，fail/caveat 不能获无保留通过。记录命令只记录宿主提供的观察，不声称自动证明截图语义或人类身份；人工批准关卡仍保留。不要把 observation.json 放到源码输入中反复修改，可使用临时目录。

同一 AC、同一种人工观察的新记录替换旧记录；当前源码上的任一其他失败或 caveat 仍会阻塞。人工 pass 不能覆盖自动命令失败，须修复后重新运行命令。重新运行自动验证会更新本次命令记录，并保留人工观察。

旧 change 的 covers 映射不会自动提升成执行证据；按错误提示运行 verify-ac 或补实际 UAT 记录。缺 SPEC/无 AC 保持原有 skip 语义。有 AC 而缺证据时始终阻塞，`--skip/--force` 不能绕过。独立 task 的 receipt 证明任务 verify；AC 验证证明 TEST/INTEGRATION 覆盖，两者复用同一快照与进程判据，不是第二套完成状态。

同一次 `gantry verify-ac` 调用内，完全相同的命令只执行一次，结果仍分别关联每个 commandKey 和 AC；任一失败仍阻断。推荐用一条命令的多个 covers 表达共用验证。命令字符串不同不推测等价，不跨调用缓存：下一次调用会重新执行，确保远程状态不会因本地摘要相同而被沿用。按环境不同的验证必须把环境选择写入命令，不能依赖同名命令暗中切换目标。INTEGRATION 只补缺失或失效检查，不按 task/wave 重复部署同一候选。

## 门禁作为循环反馈

`gantry loop` 的可恢复门禁进入「诊断 → agent 分析并修复 → 真实验收」循环，耗尽后返回最后原因。DEV 的失败详情保存在原 task record，阶段失败详情通过冻结 pack 的 `gateFeedback` 传入，两种 adapter 都明确读取它。阶段退出码 1/2 的门禁失败均可重试；已有 DESIGN/UAT 草稿若实际门禁失败也重新派发。阶段重试不消耗成功推进的 step 配额。

`ralph.maxRepairs` 是初次候选之后的修复次数，默认 3，允许非负安全整数（0 表示不修复）。阶段门禁使用 `autonomous.maxRetries`（默认 3）。执行边界读最新值；任务 record 和阶段 `metrics.jsonl` 记录预算，重启不清零，降低上限不损坏历史，增大上限可继续。已完成任务证据失效且重验失败时，由所属任务继续修复。

人工批准、用户取消、总时限、执行超时、锁冲突、活跃进程/清理未确认、控制记录损坏和用户提交归属不明仍直接退出，不能通过重复派发解决。独立 `gantry done` 只返回当前验收结果，持续收敛由 `loop` 负责；不把失败写成完成，不通过删除测试或更改验收标准消除门禁。

Skill 入口（next/auto/resume/debug/review）与阶段协议同样消费 gateFeedback/retryHistory 和 task failure，复用宿主预算；不因 hook、报告、runner 或首次 flaky 直接结束。skill/phase/hook/review 不另开计数；候选进程不嵌套启动 loop。恢复原契约只允许精确还原保存的验收字段，不能修改完成状态或控制记录。空 hook 通过 pack 清单直接跳过，配置刷新后重新判断。更新其他项目已安装的 skill 时重新执行 `gantry install --tool <工具>`，不会仅因 CLI 源码更新自动刷新项目内的 skill 文件。

相关实现：`src/lib/task-cycle.mjs`、`task-record.mjs`、`task-evidence.mjs`、`failure-classification.mjs`、`ac-evidence.mjs`、`process-runner.mjs`、`loop-guard.mjs`。
