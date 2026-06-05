# Harness Engineering 规划

> 基于《Agent Harness Engineering: A Survey》ETCLOVG 框架的对齐分析，
> 当前 Gantry 整体对齐度约 55%。本文件记录所有未对齐/需要补全的功能任务。
>
> 优先级顺序：O（可观测）→ V（验证）→ G（治理）→ E（沙箱）→ T（工具）
>
> 参考分析：见会话记录「Harness 对 Gantry 的 ETCLOVG 逐层分析」

---

## 当前对齐度快照

| ETCLOVG 层 | 当前 | 目标 | 核心缺口 |
|---|---|---|---|
| E · 执行环境 | 40% | 80% | write_files 机器执行、沙箱活性 |
| T · 工具接口 | 75% | 90% | function-calling schema、动态发现 |
| C · 上下文 | 90% | 95% | 语义检索记忆（长期规划）|
| L · 生命周期 | 85% | 95% | 多 Agent 并行（v3.0）|
| O · 可观测 | 15% | 80% | **最大短板，执行轨迹几乎空白** |
| V · 验证评估 | 60% | 85% | 过程/路径验证、失败归因 |
| G · 治理安全 | 20% | 75% | RBAC、审计日志、声明式策略 |

---

## P1 · 可观测层（O）优先级最高

> 没有 trace，所有失败都是黑盒。这是当前影响整体能力最大的缺口。

### O-1 执行轨迹记录

**问题**：gantry 命令执行情况完全不可见，没有"发生了什么"的机器可读记录。

**目标**：每次 gantry 命令执行时，向 `.planning/trace/` 写入结构化日志。

**产物**：
- `.planning/trace/<YYYY-MM-DD>.jsonl`：每行一条 trace 事件
- 事件结构：
  ```json
  {
    "ts": "2026-06-04T10:23:00Z",
    "cmd": "gantry next",
    "change_id": "order-export",
    "stage_from": "design",
    "stage_to": "task",
    "duration_ms": 0,
    "result": "ok",
    "gate_checks": ["DESIGN.md: ok"],
    "user": "mjk"
  }
  ```

**实现位置**：`orchestrator/cli.mjs` 每个命令函数退出前写 trace。

**依赖**：无

**工作量估计**：M（CLI 改动 + trace schema 设计）

---

### O-2 `gantry trace` 查询命令

**问题**：即使有 trace 文件，没有命令行工具读取和展示。

**目标**：`gantry trace [change-id]` 输出指定 change 的完整执行轨迹摘要。

**产物**：
```
$ gantry trace order-export

change: order-export
started: 2026-06-04 10:23
stages:
  change     → requirement  10:23  ok    （等待 checkpoint 2h 15m）
  requirement → design       12:38  ok
  design     → task          14:01  ok
  task       → dev           14:05  ok
    T01: auth-middleware      14:06  ok  verify: passed
    T02: export-api           15:30  ok  verify: passed
    T03: frontend-download    16:45  FAIL → retry 1 → ok
  dev        → test          17:20  ok
  test       → review        18:00  ok
  review     → ship          18:45  ok

total duration: 8h 22m
checkpoint wait: 2h 15m（change → requirement）
retry count: 1（T03 frontend-download）
```

**依赖**：O-1

**工作量估计**：S

---

### O-3 `gantry metrics` 升级（读 trace）

**问题**：当前 `gantry metrics` 只统计 git commit，不分析执行过程。

**目标**：升级为读取 trace 数据，输出工程效率分析。

**新增指标**：
- 各阶段平均耗时（cycle time per stage）
- 最长 checkpoint 等待（人工瓶颈识别）
- 任务重试率（哪类 task 最容易失败）
- fast: commit 占比（从 git log）
- change 平均交付周期

**产物**：`.specs/metrics/<YYYY-MM>.md` 新增 §0 执行效率摘要

**依赖**：O-1

**工作量估计**：M

---

## P2 · 验证评估层（V）优先级次之

### V-1 语义阶段门禁

**问题**：当前阶段门禁只检查文件存在性（`existsSync`），不检查内容质量。

**目标**：门禁时检查关键字段完备性，提供质量警告（警告而非硬阻断）。

**检查规则**：
```javascript
// 进入 DEV 阶段时检查 TASK.md
- 每个 task 条目是否有 verify 字段？
- verify 是否是可执行命令（非空、非"待补充"）？
- wave 分组是否合理（依赖关系没有循环）？

// 进入 REVIEW 时检查
- TASK.md 所有 task 是否标记 done？
- 是否有未关闭的 PATCH.md 项？

// 进入 SHIP 时检查
- REVIEW.md 是否有未处理的 Critical 项？
```

**产物**：`orchestrator/lib/gate.mjs` 新增 content-check 函数

**依赖**：无

**工作量估计**：M

---

### V-2 失败归因诊断

**问题**：UAT 失败时，只知道"失败了"，不知道是哪层 harness 的问题。

**目标**：`gantry verify --diagnose` 输出结构化归因建议。

**归因逻辑**：
```
UAT 失败时检查：
1. verify 命令是否真的运行了？（V 层问题）
2. 失败的代码是否在 write_files 声明范围内？（E 层问题）
3. 失败的逻辑是否在 DESIGN.md 有对应设计？（C 层问题）
4. 同类失败是否在 LESSONS.md 有历史记录？（知识层问题）
→ 输出：最可能的故障层 + 建议检查点
```

**产物**：`phases/7-integration.md` 新增失败诊断协议 + CLI `--diagnose` 标志

**依赖**：O-1（trace 数据辅助归因）

**工作量估计**：M

---

### V-3 ORR（运营就绪评审）阶段

**问题**：可观测性在 TEST 阶段才检查，Harness 论文要求"第一天就装"，应在 DESIGN → TASK 之间。

**目标**：新增轻量 ORR checklist，在技术设计确定后、任务拆分前确认运营就绪。

**新阶段位置**：
```
DESIGN → [O-orr] → TASK
```

**ORR 检查项**（`phases/O-orr.md`）：
1. 架构合规：是否对齐既有模块边界？
2. 可用性：降级策略 / 超时 / 重试是否设计？
3. 安全：权限变更 / 数据访问范围是否评估？
4. 可观测性：日志 / 指标 / 告警是否第一天就有？
5. 成本：新增资源消耗预估

**产物**：
- `phases/O-orr.md`
- `templates/ORR.md`
- `commands/orr.md`
- CLAUDE.md 注册
- METHODOLOGY.md 流程图更新

**依赖**：无

**工作量估计**：M（新增 phase）

---

## P3 · 治理安全层（G）

### G-1 操作审计日志

**问题**：谁在什么时间执行了什么 gantry 命令，完全没有记录。

**目标**：STATE.md 新增操作日志段，每次 gantry 命令自动追加。

**格式**：
```markdown
## 操作日志（最近 50 条）

| 时间 | 命令 | Change | 阶段变化 | 执行者 |
|---|---|---|---|---|
| 2026-06-04 10:23 | gantry change | order-export | idle→change | mjk |
| 2026-06-04 12:38 | gantry next | order-export | change→requirement | mjk |
| 2026-06-04 18:45 | gantry ship | order-export | review→idle | mjk |
```

**实现**：CLI 每次执行后 append 到 STATE.md 的审计段；超过 50 条时自动归档到 `.planning/trace/`。

**依赖**：无（独立于 O-1）

**工作量估计**：S

---

### G-2 产物元数据标记

**问题**：没有机器可读的方式区分哪些内容是 AI 生成、哪些是人工审核。

**目标**：在所有 AI 产出的 `.md` 产物中加入 frontmatter 元数据。

**格式**：
```yaml
---
change_id: order-export
phase: requirement
ai_generated: true
human_reviewed: false
generated_at: 2026-06-04T12:38:00Z
model: claude-sonnet-4-6
---
```

**实现位置**：每个阶段 prompt 的输出规范中加入"产物必须包含以下 frontmatter"约定；C-curator 月度整理时统计 `human_reviewed: false` 的积压量。

**依赖**：无

**工作量估计**：S（prompt 规范修改）

---

### G-3 声明式策略层（Policy-as-Code）

**问题**：RULES.md 是 Markdown，AI 荣誉执行，没有机器强制。

**目标**：关键规则转化为可在 CLI 执行时机器检查的策略脚本。

**设计**：
```javascript
// policies/require-verify.mjs
export function check({ task }) {
  const missing = task.items.filter(t => !t.verify || t.verify.trim() === '');
  return { pass: missing.length === 0, violations: missing.map(t => t.id) };
}

// 使用
gantry gate --policy require-verify   // CI/pre-commit 时运行
```

**内置策略**：
- `require-verify`：所有 task 必须有 verify 命令
- `no-open-critical`：REVIEW.md 没有未处理 Critical
- `patch-closed`：PATCH.md 所有项已勾选
- `no-scope-creep`：diff 文件范围在 write_files 声明内

**产物**：`policies/` 目录 + `gantry gate` 命令扩展

**依赖**：G-1

**工作量估计**：L

---

### G-4 轻量 RBAC

**问题**：任何人都能执行任何 gantry 命令，无权限边界。

**目标**：通过 `.planning/config.json` 定义角色权限，`gantry ship` / `gantry gate --force` 等高风险命令需要对应权限。

**设计**：
```json
{
  "rbac": {
    "enabled": true,
    "roles": {
      "developer": ["change", "next", "exec", "adjust", "verify"],
      "reviewer": ["review", "verify", "gate"],
      "lead": ["ship", "archive", "unarchive", "gate --force"]
    },
    "default_role": "developer"
  }
}
```

**依赖**：G-1（需要知道谁在执行）

**工作量估计**：L

---

## P4 · 执行层（E）沙箱强化

### E-1 write_files 机器执行

**问题**：`TASK.md` 的 `write_files` 声明目前只是 AI 参考，CLI 不做机器检查。

**目标**：`gantry exec` 时自动拦截超出 write_files 声明的文件改动。

**实现思路**：
1. 执行前读取当前 task 的 write_files 声明
2. 执行后（AI 完成后）对比 `git diff --name-only`
3. 发现超边界文件时：输出警告 + 提示是否创建新 task 扩展范围

**注意**：不能全自动回滚（可能误判），只做检测 + 提示。

**产物**：`orchestrator/cli.mjs` exec 命令增加 post-check；`orchestrator/lib/scope-guard.mjs` 扩展

**依赖**：无

**工作量估计**：M

---

## P5 · 工具接口层（T）

### T-1 命令 Schema 结构化

**问题**：`commands/*.md` 是人类可读 prompt，没有 function-calling 结构。

**目标**：在 frontmatter 中增加结构化 schema，支持未来 MCP/A2A 集成。

**格式扩展**：
```yaml
---
name: gantry:change
description: 启动新变更提案（阶段 0）
agent: planner
stage: change
parameters:
  - name: description
    type: string
    required: true
    description: 一句话变更描述
  - name: change_id
    type: string
    required: false
    description: 手动指定 change-id（默认自动生成）
---
```

**产物**：所有 `commands/*.md` frontmatter 更新 + `tools/renderers/` 更新以生成结构化输出

**依赖**：无

**工作量估计**：M（23 个文件）

---

## 执行顺序建议

```
P1-O1 trace 记录   →  P1-O2 gantry trace  →  P1-O3 metrics 升级
        ↓
P3-G1 审计日志     →  P2-V1 语义门禁
        ↓
P2-V3 ORR 阶段     →  P2-V2 失败归因
        ↓
P3-G2 产物元数据   →  P3-G3 策略层       →  P4-E1 write_files 执行
        ↓
P3-G4 RBAC（团队场景时再做）
P5-T1 schema（MCP 集成前再做）
```

**最快提升路径**：P1-O1 + P3-G1 + P2-V1 三件事，可以把整体对齐度从 55% 推到 70%+，且都是 CLI 改动，不需要新增外部依赖。

---

## 任务状态

| 任务 | 优先级 | 状态 | 工作量 |
|---|---|---|---|
| O-1 执行轨迹记录 | P1 | 📋 待做 | M |
| O-2 gantry trace 命令 | P1 | 📋 待做 | S |
| O-3 metrics 升级 | P1 | 📋 待做 | M |
| V-1 语义阶段门禁 | P2 | 📋 待做 | M |
| V-2 失败归因诊断 | P2 | 📋 待做 | M |
| V-3 ORR 阶段 | P2 | 📋 待做 | M |
| G-1 操作审计日志 | P3 | 📋 待做 | S |
| G-2 产物元数据标记 | P3 | 📋 待做 | S |
| G-3 声明式策略层 | P3 | 📋 待做 | L |
| G-4 轻量 RBAC | P3 | 📋 待做 | L |
| E-1 write_files 机器执行 | P4 | 📋 待做 | M |
| T-1 命令 Schema 结构化 | P5 | 📋 待做 | M |

> 工作量：S = 0.5-1天，M = 1-3天，L = 3-7天
