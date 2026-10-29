# EXECUTION: task-ralph-loop

## tier-decision
tier: full
source: default

### T01

- status: done
- completed_at: 2026-10-29T02:51:48.214Z
- summary: 基础模块实现及真实进程边界验证
- verify: node --test tests/ralph-record.test.mjs tests/ralph-process.test.mjs; exit 0; 18 pass
- evidence: 原子记录/跨进程锁/初次加三修复/超时取消和后代清理真实探针通过
- problem: 仅等待客户端close可能被后代管道阻塞
- cause: 后代继承stdout使leader已退出仍无法close
- next: none

### T03

- status: done
- completed_at: 2026-10-29T02:51:48.259Z
- summary: 基础模块实现及真实进程边界验证
- verify: node --test tests/ralph-record.test.mjs tests/ralph-process.test.mjs; exit 0; 18 pass
- evidence: 原子记录/跨进程锁/初次加三修复/超时取消和后代清理真实探针通过
- problem: 仅等待客户端close可能被后代管道阻塞
- cause: 后代继承stdout使leader已退出仍无法close
- next: none

### T02

- status: done
- completed_at: 2026-10-29T02:55:46.656Z
- summary: 固定验收contract和工作区内容凭据
- verify: node --test tests/ralph-evidence.test.mjs; exit 0; tests=13 pass=13 fail=0 skipped=0 todo=0
- evidence: dirty/index/untracked/删除与模式变化、暂存测试弱化、TAP空跑、内容receipt失效均通过实际临时Git测试
- problem: 仅比较worktree可遗漏暂存测试弱化
- cause: 索引与worktree可能包含不同内容
- next: 将两层内容均纳入基线和弱化比较，未知runner计数保持null

## 自举迁移边界

本change在新TaskRecord内核实现前已启动。T01/T02/T03旧done已写done，但并非新receipt认证。T04—T07实现与外部verify已完成，正式TASKS状态仍pending，等待明确迁移。实际done T04返回blocked(exit2)，没有补造入口基线、没有重置预算。以下是实际实现事实，不是新内核完成凭据。

### T04 · 实现候选已验证

- status: verified-awaiting-migration
- summary: task-cycle、持久化外部重试与恢复、真实验收完成事务
- verify: 26项行为回归纳入868/868全量；focused25/25加重复ID1/1
- evidence: 详见TEST.md AC映射及真实临时Git/进程测试
- problem: 外部重试重启可能新建业务预约
- cause: 恢复未区分退避预约与业务修复
- next: 持久化externalRetryPending，恢复先verify且沿用原额度

### T05 · 实现候选已验证

- status: verified-awaiting-migration
- summary: Node控制器、阶段批准、冻结pack和两adapter
- verify: focused43/43；light组合153/153；三任务真实DEV与嵌套CLI取消
- evidence: 详见TEST.md AC映射及真实临时Git/进程测试
- problem: Shell中文标点紧邻变量导致set -u失败
- cause: 未用${变量}明确变量边界
- next: 真实启动两adapter并在启动前机械核对pack

### T06 · 实现候选已验证

- status: verified-awaiting-migration
- summary: 统一done/dispatch/advance/heal/context、组合校验及安全提交
- verify: 真实CLI/Git4/4；全量868/868
- evidence: 详见TEST.md AC映射及真实临时Git/进程测试
- problem: 暂存修改会使基于索引的receipt过期
- cause: receipt绑定真实索引内容
- next: 安全暂存后再次checkpoint再commit；保留用户索引

### T07 · 实现候选已验证

- status: verified-awaiting-migration
- summary: 阶段协议、宿主renderer、模板及实际金额舍入使用说明
- verify: 协议18/18；build成功；verify39文件0错误
- evidence: 详见TEST.md AC映射及真实临时Git/进程测试
- problem: renderer额外注入旧wave/fallback指令
- cause: 只改skills无法覆盖renderer二次注入
- next: 源与renderer统一后重新build；按PATCH补安装回归

<!-- ralph-task:T01:begin -->
### T01 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: ac805829-be0e-4950-b7bf-6dc69983fe04; repairs: 3/3
- verify: `node --test tests/ralph-record.test.mjs` (exit 0, tests unknown)
- problem: none
- cause: none
- next: none
<!-- ralph-task:T01:end -->

<!-- ralph-task:T02:begin -->
### T02 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: 4456922f-31ef-4ed6-a0a7-27baba900159; repairs: 3/3
- verify: `node --test tests/ralph-evidence.test.mjs` (exit 0, tests unknown)
- problem: none
- cause: none
- next: none
<!-- ralph-task:T02:end -->

<!-- ralph-task:T03:begin -->
### T03 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: 207fabb1-886f-4410-b561-5de6fe6af511; repairs: 3/3
- verify: `node --test tests/ralph-process.test.mjs` (exit 0, tests unknown)
- problem: none
- cause: none
- next: none
<!-- ralph-task:T03:end -->

<!-- ralph-task:T04:begin -->
### T04 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: c96fe0a7-aff2-49c9-91a6-8664190a4fe1; repairs: 3/3
- verify: `node --test tests/ralph-task-cycle.test.mjs tests/ralph-recovery.test.mjs` (exit 0, tests unknown)
- problem: none
- cause: none
- next: none
<!-- ralph-task:T04:end -->

## Self-Heal Log

### T05 · attempt #1

- at: 2026-10-29T03:40:17.693Z
- reason: blocked: verification-mutated-content
- command: `node --test tests/loop-next.test.mjs tests/loop-next-cli.test.mjs tests/loop-driver.test.mjs tests/ralph-stage.test.mjs`
- stderr:
  ```
  ✔ compatibility shell validates usage and accepts verbose alias (240.608625ms)
  ✔ real driver streams candidate, writes metric, stops at concrete design gate (176.332625ms)
  ✔ quiet keeps stream in log, unknown nonzero is blocked without dispatch retry (71.970875ms)
  ✔ run deadline cleans actual child writer before returning budget exit (375.902792ms)
  ✔ invalid stage limit rejects before model launch (53.958708ms)
  ✔ AC-5 · full pipeline · design 阶段 → gantry-design (64.258125ms)
  ✔ AC-5 · full pipeline · integration + stale ok → current integration, exit 0 (64.319542ms)
  ✔ AC-1/AC-5 · light pipeline · fast + ok → done (58.202458ms)
  ✔ AC-1/AC-5 · light pipeline · fast 未 ok → gantry-fast, exit 0 (57.951875ms)
  ✔ AC-5 · blockedReason → stdout=blocked, exit 2 (104.127417ms)
  ✔ AC-5 · fence.nextStep 与实际阶段不一致 → blocked (54.179084ms)
  ✔ AC-5 · idle 阶段 → gantry-change (48.814917ms)
  ✔ AC-5 · 输出严格单行,不带装饰 (49.824875ms)
  ✔ full executes current change, even stale success cannot skip it (0.770375ms)
  ✔ full executes current requirement, even stale success cannot skip it (0.080792ms)
  ✔ full executes current design, even stale success cannot skip it (0.044208ms)
  ✔ full executes current task, even stale success cannot skip it (0.057375ms)
  ✔ full executes current dev, even stale success cannot skip it (0.0495ms)
  ✔ full executes current test, even stale success cannot skip it (0.034458ms)
  ✔ full executes current review, even stale success cannot skip it (0.034167ms)
  ✔ full executes current integration, even stale success cannot skip it (0.041833ms)
  ✔ full explicit nextStep cannot bypass position, including invalid token (0.1015ms)
  ✔ blockedReason wins over success (0.126667ms)
  ✔ light fast preserves in-progress and convergence behavior (0.155666ms)
  ✔ idle token remains change; controller decides whether change exists (0.061791ms)
  ✔ unknown pipeline uses full current-stage behavior (0.292375ms)
  ✔ unknown/missing stage fails closed and all outputs are whitelisted (0.253667ms)
  ✔ exported contracts remain immutable (0.165458ms)
  ✔ approval is bound to bytes/change and survives ordinary state updates (8.913042ms)
  ✔ missing primary artifact cannot be approved (1.393084ms)
  ✔ real CLI: fresh design executes matching pack then stops at approval (133.268291ms)
  ✔ existing unapproved draft is not rewritten on restart (75.154417ms)
  ✔ idle cannot silently create change; token mismatch cannot dispatch (25.854416ms)
  ✔ pack validator rejects phase/stage/task/change mismatch (0.176333ms)
  ✔ invalid or malformed run deadlines fail before dispatch (1.579ms)
  ✔ quiet keeps client output in run log (149.015625ms)
  ✔ real DEV controller converges three dependent tasks, refreshes repair packs and commits once (5782.4235ms)
  ✔ non-DEV failed artifact gate retries are bounded independently of task repairs (248.12ms)
  ✔ light controller keeps its existing fast gate and archive flow outside task-cycle (455.40475ms)
  ✔ both adapters enforce frozen pack identity before launching the model (377.6385ms)
  ✔ new change clears previous convergence and approval metadata (3.680083ms)
  ✔ successful transition clears phase-local nextStep but preserves approved bytes (2.938125ms)
  ✔ cancelling the nested CLI checkpoint waits until its TERM-ignoring verifier stops writing (2331.149625ms)
  ℹ tests 43
  ℹ suites 0
  ℹ pass 43
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 9677.971292
  ```

<!-- ralph-task:T05:begin -->
### T05 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: 5a2a195e-98d5-46f3-9247-6597dafd4dff; repairs: 3/3
- verify: `node --test tests/loop-next.test.mjs tests/loop-next-cli.test.mjs tests/loop-driver.test.mjs tests/ralph-stage.test.mjs` (exit 0, tests unknown)
- problem: verification-mutated-content
- cause: see persisted command diagnostics
- next: review persisted diagnostics
<!-- ralph-task:T05:end -->

<!-- ralph-task:T06:begin -->
### T06 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: 68500408-707b-4e6d-87c9-5d0ba24d36cb; repairs: 3/3
- verify: `node --test tests/ralph-integration.test.mjs tests/autonomous-task-dispatch.test.mjs tests/context-pack.test.mjs tests/heal-cli.test.mjs tests/approval-gate.test.mjs` (exit 0, tests unknown)
- problem: none
- cause: none
- next: none
<!-- ralph-task:T06:end -->

### T07 · attempt #1

- at: 2026-10-29T03:47:06.625Z
- reason: failed: unknown-test-counts
- command: `node --test tests/ralph-protocol.test.mjs tests/prompt-text-check.test.mjs && npm run build && npm run verify`
- stderr:
  ```
  ▶ T17 · prompt 文本落位检查
    ✔ 0-change.md 含 --tier + light，且不再含 tier-router (0.524166ms)
    ✔ 4-dev.md 已去 micro 档，且保留 R2.5 自愈上限 (0.19575ms)
    ✔ 6-review.md 含 review_context_leak + review-lane-guard (0.196125ms)
    ✔ 7-integration.md 含 friction + Curator 且移除手动提名 LESSONS (0.223083ms)
    ✔ K-knowledge.md 输出路径改为 .gantry/learnings/team/ + tags:[knowledge] (0.297042ms)
    ✔ F-fast.md 引用 src/lib/hard-rules.mjs 单点收敛 (0.307209ms)
    ✔ T-FIX-09 · F-fast 红线段与 HARD_RULE_KEYWORDS 语义对齐 (0.781667ms)
    ✔ CLAUDE.md 红线段主语改 lane + R1.8 引用 .gantry/learnings/team/ (0.416334ms)
    ✔ LESSONS.md 顶部含 MIGRATED to .gantry/learnings/team/ (0.210333ms)
    ✔ LESSONS 老文件仍存在（兼容读 6 个月） (0.110334ms)
  ✔ T17 · prompt 文本落位检查 (3.928292ms)
  ▶ AC-16 · micro 管线残留清零 + F-fast 描述新 light
    ✖ phase 产物 / 两个公开 skill / docs/loop.md 均无 micro 管线描述 (2.050166ms)
    ✔ CLAUDE.md / AGENTS.md 不再描述旧 light 流程（change → fast → integration / 内部判定） (0.104125ms)
    ✔ F-fast.md 描述 light：含 light.json + gantry advance，且不要求 PROPOSAL (0.0735ms)
  ✖ AC-16 · micro 管线残留清零 + F-fast 描述新 light (2.339333ms)
  ✔ full DEV protocols agree on single-task reservation, candidate boundary and actual completion (0.922958ms)
  ✔ TASKS template declares optional command lists without splitting shell comma arguments (2.31125ms)
  ✔ both adapters reject DEV without a task and mismatched frozen pack before invoking a client (100.1345ms)
  ✔ user docs retain content receipts, bounded failures and honest recovery limits (0.311125ms)
  ✔ rendered Codex and Claude auto skills cannot reintroduce parallel waves or unbounded fallback (1.781875ms)
  ℹ tests 18
  ℹ suites 2
  ℹ pass 17
  ℹ fail 1
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 155.800375
  
  ✖ failing tests:
  
  test at tests/prompt-text-check.test.mjs:137:3
  ✖ phase 产物 / 两个公开 skill / docs/loop.md 均无 micro 管线描述 (2.050166ms)
    Error: ENOENT: no such file or directory, open '/Users/mjk/workspace/ai/platform/gantry-ralph-loop-finalize/.claude/skills/gantry-change/SKILL.md'
        at readFileSync (node:fs:621:20)
        at TestContext.<anonymous> (file:///Users/mjk/workspace/ai/platform/gantry-ralph-loop-finalize/tests/prompt-text-check.test.mjs:145:23)
        at Test.runInAsyncScope (node:async_hooks:226:14)
        at Test.run (node:internal/test_runner/test:1402:25)
        at Test.start (node:internal/test_runner/test:1262:17)
        at node:internal/test_runner/test:1903:71
        at node:internal/per_context/primordials:504:82
        at new Promise (<anonymous>)
        at new SafePromise (node:internal/per_context/primordials:478:3)
        at node:internal/per_context/primordials:504:9 {
      errno: -2,
      code: 'ENOENT',
      syscall: 'open',
      path: '/Users/mjk/workspace/ai/platform/gantry-ralph-loop-finalize/.claude/skills/gantry-change/SKILL.md'
    }
  ```

<!-- ralph-task:T07:begin -->
### T07 · verified

- receipt: fd282215895d1db3e546dd1c1c8e49e6f423d522131d4511e8b493cdf1b9ebb0
- attempt: 34cbbe0b-ea9e-485a-944e-b05c9327f3b4; repairs: 3/3
- verify: `node --test tests/ralph-protocol.test.mjs tests/prompt-text-check.test.mjs && npm run build && npm run verify` (exit 0, tests unknown)
- problem: unknown-test-counts
- cause: see persisted command diagnostics
- next: review persisted diagnostics
<!-- ralph-task:T07:end -->

## 用户确认后的迁移与DEV收尾

用户已确认审阅后的实现作为迁移锚。七任务全部经真实verify生成receipt；历史预算无法证明精确值，保守锁定已消耗修复上界3，不再授新自动修复，未调用模型。记录明确标记legacy migration而非任务前快照。原EXECUTION事实保留，先前awaiting-migration叙述为历史。

并发工作修改同一源码时，本change转入独立worktree，47个文件按初始审阅快照逐个hash校对，原目录未被回退或覆盖。DEV仅提交这47个文件与本EXECUTION，不提交用户README、网站、另一项工作源码、TaskRecord/锁/日志。安全暂存后重验全部任务，最终一个DEV commit。
