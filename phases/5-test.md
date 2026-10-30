# 阶段 5 · TEST — 五轮测试金字塔

## Context Pack 优先

> 复用入口已加载的 context pack；尚未加载时再读 `.gantry/planning/context-pack.json`。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


> **核心思想**：测试不是"跑一下单测"，是 5 个维度的金字塔。
> 每轮按项目类型可裁剪。本 prompt 决定**做哪几轮**；具体怎么做查 `@gantry/reference/test-pyramid.md`。

## 角色

Test Engineer。

## Pre-hook（可选）

先消费 pack 的 `hook-before`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时读一次有效 hook 配置；为空则本上下文内跳过，配置变化后重新判断。CLI 已执行的 before:change / before:dev 不重复执行。

在进入本阶段主流程前，运行：
```bash
gantry hook run before:test
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 输入

- `@.gantry/specs/<change-id>/SPEC.md`（AC + 非功能性需求）
- `@.gantry/specs/<change-id>/DESIGN.md`（只读 `## 0. 技术栈选定` 及当前测试相关的契约；工具选择必须匹配栈）
- `@.gantry/specs/<change-id>/TASKS.md`
- `@.gantry/specs/<change-id>/EXECUTION.md` 的相关 task 证据；需要独立交接细节时才跟随 SUMMARY 链接，不扫描或复制全部报告
- 已存在的测试代码
- `@gantry/reference/test-pyramid.md`（5 轮的工具 / 标准 / 清单）

## 你的职责

### 共用验证先收口

TEST 按 change 执行一次覆盖评估，不按 task / wave 启动完整五轮。由一个验证负责人先检查 EXECUTION 和已有 TEST 证据，列出未覆盖或已失效的检查，再统一准备目标环境与测试数据。独立检查可并发；共享部署、可写测试数据及有副作用的操作由负责人串行组织。

在现有范围声明中记录共用命令、目标环境、负责阶段及已有证据路径。相同命令覆盖多个 AC 时优先在 test-commands.yml 使用一条命令和多个 covers；`gantry verify-ac` 同次调用会合并完全相同的命令。先配置完整映射，再统一执行 verify-ac；不要先手跑同一命令后立即让 CLI 再跑，也不要为每个 AC 各调用一次。

下游仅在证据绑定的代码、索引、命令、配置和目标环境仍匹配且满足当前覆盖要求时引用；缺失、过期或无法确认则重跑。远程状态、部署版本或测试数据变化时重跑对应检查；本地源码摘要不能证明远程结果仍有效。复用不是跳过，不把单 task 的通过当成全量或端到端通过。

### 步骤 0 · 声明本次走哪几轮（强制）

在 `TEST.md` 开头**显式输出适用矩阵**，对照 `test-pyramid.md` 末尾的「适用矩阵」表，按项目类型决定每轮是「✅ 必跑 / ⚠️ 部分 / ❌ 跳过」。

格式：

```
## 本次测试范围声明

| 轮次 | 状态 | 范围 | 跳过理由（如跳过）|
|---|---|---|---|
| 第 1 轮 · 功能 | ✅ 必跑 | 全部 AC | — |
| 第 2 轮 · 性能 | ✅ 必跑 | Lighthouse + bundle size | — |
| 第 3 轮 · 安全 | ⚠️ 部分 | 依赖 + 秘钥扫描 | 内部工具，OWASP 减项 |
| 第 4 轮 · 兼容 | ✅ 必跑 | Chrome/Firefox/Safari | 不需要 IE |
| 第 5 轮 · 可观测 | ❌ 跳过 | — | CLI 工具，无运行时 |
```

> **跨服务端到端路径不在本阶段验证**。SPEC「关键用户路径」定义的跨服务 Journey，其端到端验收（拉起多方按路径跑 + 断点归属）统一移交 `phases/7-integration.md` 做一次，避免与本阶段重复。本阶段专注**单服务**的功能 / 性能 / 安全 / 兼容 / 可观测。单服务内的接口单测、契约单测仍在第 1 轮正常覆盖。
>
> TEST 不重复解释每个 task 的 `<verify>`，而是从 SPEC 的 AC 出发扩大覆盖：补齐跨 task 的功能、边界、失败路径和非功能性验证。

**禁止**没声明就跳过任何轮次。每个 ❌ 必须有理由。

---

### 第 1 轮 · 功能测试（Functional）

#### 1.1 测试矩阵

每条 AC 映射到测试用例：

| AC | 类型（unit/integration/e2e/manual）| 用例文件 / UAT 编号 | 状态 |
|---|---|---|---|
| AC-1 | unit | `theme.test.ts` | ✅ |
| AC-2 | e2e | `theme.e2e.ts` | 🟡 待补 |
| AC-3 | manual | UAT-1 | — |

**强制**：每条 AC ≥ 1 条覆盖。空缺必须解释。

#### 1.2 UAT 脚本（无法自动化的 AC）

```
UAT-1：<场景>
  前置：<状态>
  步骤：1. ... 2. ... 3. ...
  期望：- ... - ...
```

#### 1.3 覆盖率与边界

- 需要覆盖率时，将 `<test-cmd> --coverage` 作为本阶段相应的实际验证命令，输出保留一份；避免先跑同套测试再仅为覆盖率重跑
- 关键路径行覆盖 ≥ 项目门槛（默认 80%；core 模块 ≥ 90%）
- 边界值用例（空 / 极大 / 极小 / Unicode / null）≥ 3 条
- 错误路径必须有显式测试

> 工具与反模式详见 `test-pyramid.md` 第 1 节。

#### 1.4 测试质量自检 · 6 维测试衰退风险

> 覆盖率达标 ≠ 测试写得好。本步检查「测试本身」的衰退风险。

以 [brooks-lint](https://github.com/hyhmrright/brooks-lint) 提出的 6 个测试衰退风险为诊断维度（源于《xUnit Test Patterns》/《The Art of Unit Testing》/《How Google Tests Software》/《Working Effectively with Legacy Code》四本书）：

| 编号 | 衰退风险 | 诊断问题 |
|---|---|---|
| T1 | Test Obscurity 测试晦涩 | 读这个测试能马上看出「它在验证什么」吗？ |
| T2 | Test Brittleness 测试脆弱 | 重构实现会让这个测试坏掉吗（但行为仍正确）？ |
| T3 | Test Duplication 测试重复 | 同一个场景是否被多个测试换个姿势验证？ |
| T4 | Mock Abuse Mock 滥用 | mock 是否遮蔓了真实问题 / 是否 mock 了不属于被测单元的东西？ |
| T5 | Coverage Illusion 覆盖率幻觉 | 覆盖率高但 assertion 空 / 只验证不报错？ |
| T6 | Architecture Mismatch 架构错配 | 测试层级是否与架构匹配（不该用 e2e 验证的点被拿 e2e 验）？ |

##### 路径 A · 装了 brooks-lint（首选）

```
/brooks-test            # 测试套件质量审查
```

输出使用 4 要素格式（Symptom / Source / Consequence / Remedy），原样贴入 `TEST.md` 的「测试质量自检」段。

##### 路径 B · 未装 brooks-lint（内置清单）

逐个维度检查，命中任一项记下测试文件列表：

- [ ] **T1**：测试名不是 Given/When/Then 结构，读不出场景 → 重命名
- [ ] **T2**：测试断言实现细节（调用了哪个内部函数、某变量是某值）而非外部行为 → 改验证输入输出
- [ ] **T3**：多个测试只不过改了输入数值，其他一样 → 改参数化（table-driven / parametrize）
- [ ] **T4**：mock 了被测单元本身 / mock 了本可走真的依赖 → 去 mock
- [ ] **T5**：测试只调用了函数但没断言 · 仅有 `expect(x).toBeDefined()` 这种空断言 → 补真实断言
- [ ] **T6**：能用单测验证的逻辑被拿 e2e 验证 / 应用层逻辑被拿集成测验证 → 下移一层

命中 ≥ 1 项 → 本轮技术债记事（记入 TEST.md 的「测试质量记事」段，按优先级排入 backlog 或当圈修复）。命中 ≥ 3 项 → 本次 release 前必修。

> 工具与反模式详见 `test-pyramid.md` 第 1 节、6 维衰退详见 [brooks-lint · brooks-test skill](https://github.com/hyhmrright/brooks-lint)。

---

### 第 2 轮 · 性能测试（Performance）

#### 2.1 性能预算确认

从 `SPEC.md` 的「非功能性需求」提取性能预算；缺失时先查 DESIGN、既有项目配置与测量基线。可自行测量的先测并记录，不能编造验收阈值；仅需用户决定的新性能目标才提问，不因缺少报告字段立即暂停。

#### 2.2 前端性能（Web 项目）

- Lighthouse CI 跑关键路由：LCP / CLS / INP / TBT
- Bundle Analyzer：主包 + 路由分包大小
- 与上一版基线对比，**禁止退步**

#### 2.3 后端 / API 性能

- k6 / locust 在 N 倍业务 QPS 下的关键 API：p95 / p99 / 错误率
- 数据库慢查询审计（`EXPLAIN ANALYZE` 关键查询）
- 检测 N+1（ORM 项目必查）

#### 2.4 通过标准

逐项对照预算，输出"✅ 达标 / ❌ 退步 X% / ⚠️ 接近阈值"，**不允许"性能良好"这种空话**。

> 工具、默认阈值、反模式详见 `test-pyramid.md` 第 2 节。

---

### 第 3 轮 · 安全测试（Security）

#### 3.1 依赖漏洞扫描

```bash
npm audit --production       # 或 pip-audit / govulncheck / cargo audit
trivy image <image>          # 容器镜像扫描
```

通过：无 high / critical。命中必须修或显式接受（含理由）。

#### 3.2 秘钥扫描

```bash
trufflehog filesystem .      # 或 gitleaks detect
```

通过：0 命中。命中必须**立即 rotate** 对应密钥（不只是删 commit）。

#### 3.3 静态扫描（SAST）

Semgrep / CodeQL / Bandit 选一。无 high；medium 有处理记录。

#### 3.4 OWASP Top 10 清单

逐项标 ✅ 已测 / ❌ 不适用 / 🟡 待补：

- A01 越权 / A02 加密失败 / A03 注入 / A04 不安全设计
- A05 配置错误 / A06 漏洞组件 / A07 鉴权 / A08 数据完整性
- A09 日志监控（→ 第 5 轮）/ A10 SSRF

> 工具与反模式详见 `test-pyramid.md` 第 3 节。

---

### 第 4 轮 · 兼容性测试（Compatibility）

#### 4.1 前端跨浏览器 / 跨设备（Web 项目）

- 桌面：Chrome / Firefox / Safari / Edge（最新 2 个版本）
- 移动：iOS Safari / Android Chrome
- 视口：360 / 768 / 1024 / 1440 至少跑过

工具：Playwright 多 browser；可选 BrowserStack / LambdaTest。

#### 4.2 数据迁移测试（涉及 schema 变更必跑 · 关联 4-dev 1.7 / R4.5）

**前置**：本任务在 4-dev 步骤 1.7 已生成迁移文件（如未生成，回退到 dev 阶段——R4.5 违规）。优先从 `EXECUTION.md` 的相关 task 段追踪迁移文件路径；若该任务是例外任务，也可从 `<task-id>-SUMMARY.md`「数据库迁移」段追踪。本步对这些文件做端到端验证。

- [ ] 迁移文件路径已 trace（来自 `EXECUTION.md`，例外任务可来自 `<task-id>-SUMMARY.md`）
- [ ] 在**生产数据快照**上预演迁移脚本（不能只在 dev 数据上跑）
- [ ] 实测耗时 → 决定是否需要 maintenance window（> 30s 的 ALTER TABLE 必走窗口）
- [ ] **回滚脚本（down）就位且测过**：跑 up → 跑 down → 数据 / schema 复原 → 再跑 up
- [ ] 双写期 / 灰度方案有验证步骤（破坏性变更必填）
- [ ] 加 NOT NULL 字段：旧行 backfill 已验证（不能依赖 DEFAULT 在迁移期就位）
- [ ] 改字段类型：cast 不丢数据 / 不截断 / 不溢出已验证

#### 4.3 跨版本 / 跨编码

- [ ] 旧 schema 数据能否被新代码正确读写
- [ ] API 版本兼容（v1 客户端访问 v2 服务端）
- [ ] UTF-8 / UTF-16 / 不同 locale

> 工具与反模式详见 `test-pyramid.md` 第 4 节。

---

### 第 5 轮 · 可观测性验证（Observability）

> 不是"测系统"，是"测系统能不能被观测"。上线后看不到 = 故障无法定位。

#### 5.1 日志验证

- [ ] 关键路径入口 / 出口 / 异常都有 log
- [ ] 含 trace-id，结构化（JSON）
- [ ] **不含 PII / 秘钥 / token**（grep 验证）
- [ ] 错误日志含足够上下文

#### 5.2 指标 / 追踪

- [ ] 业务关键 metric 有打点（转化率 / 错误率 / 关键时长）
- [ ] RED 指标覆盖关键 endpoint
- [ ] 跨服务 trace 串通（如有分布式调用）

#### 5.3 告警 + 健康检查

- [ ] 关键失败有告警 + runbook 链接
- [ ] `/health` 区分 liveness / readiness
- [ ] 无噪音告警

> 工具与反模式详见 `test-pyramid.md` 第 5 节。

---

### 步骤 N · 回归测试登记

本次新加 / 修复的测试用例，在 TEST 的 AC 矩阵标注类型、位置和新增 / 修改性质；不在文末再复制一份同义清单。

## 输出

- `.gantry/specs/<change-id>/TEST.md`（用 `@gantry/templates/TEST.md` 模板，含 5 轮报告段）
- 性能 / 安全扫描的原始输出贴入或链接到附件

## 约束（强制）

- **R5.1**：测试用例从 AC 派生，不从实现派生
- **R5.2**：bug 修复必伴随回归测试，加入 LESSONS
- **R5.3**：禁止通过删除 / 弱化测试来"修复"失败
- **R5.4**（新）：不允许跳过任何轮次而没有显式理由（在范围声明里写明）
- **R5.5**（新）：性能 / 安全 / 兼容轮次的"通过 / 失败"必须基于**可量化指标**或工具输出，不允许"看起来没问题"
- AC 覆盖优先于行覆盖

## 自检

- [ ] 范围声明已输出，5 轮状态都明确
- [ ] 第 1 轮：每条 AC 有覆盖 + 覆盖率达标 + 边界用例 ≥ 3 + **测试质量 6 维自检过**
- [ ] 第 2 轮：性能预算逐项对比 + 与上版基线对比
- [ ] 第 3 轮：依赖 / 秘钥 / SAST / OWASP 各有处理记录
- [ ] 第 4 轮：跨浏览器 / 数据迁移 / 跨版本按需跑过
- [ ] 第 5 轮：日志 / 指标 / 告警 / 健康检查清单逐项验证
- [ ] 跳过的轮次都有理由
- [ ] 测试新增的用例已登记

## Post-hook（可选）

先消费 pack 的 `hook-after`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时复用已读取配置；为空则跳过。已配置 hook 每次真实阶段执行仍按配置运行，不缓存其成功结果。

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:test
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 自主模式自检（autonomous=true）

本阶段末尾禁止向用户反问「是否继续 / 要不要先扫一眼 / 是否推进下一阶段」。按 R2.6：
- 产物齐备、门禁通过 → 直接按「触发下一步」执行
- 多选场景 → 取推荐项（无推荐则取列表第一项），把选择与理由写进本阶段产物
- 停止条件按 当前工具的 `gantry-next` 入口「门禁修复循环」：人工确认/所缺用户决策或凭据、宿主剩余预算耗尽、取消/时限、进程/控制记录/用户内容保护；可恢复门禁先在本次调用内诊断修复

## 触发下一步

- 任何轮次发现 🔴 问题 → 回到 `phases/4-dev.md` 修复（产 fix 任务）
- 全部通过 → `phases/6-review.md`（review 阶段会再检查 5 轮都做了）

## 执行证据收口

完成 AC 覆盖矩阵后运行 `gantry verify-ac --json`。CLI 运行映射命令并绑定当前代码和索引；缺依赖、取消、超时、非零退出、空测试或源码变化都不能算通过。人工观察记录到 UAT，并通过 `gantry verify-ac --observation <临时JSON>` 关联 AC、步骤、实际结果和证据文件（格式见 `docs/loop.md` 的「AC 执行证据」）。不能仅填写 covers 或截图路径就声称已验证。
