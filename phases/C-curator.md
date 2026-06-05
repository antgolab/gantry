# C-curator · 知识库维护 + 团队健康巡检

> **定位**：横向命令，不推进主管线。
> **触发方式**：`gantry curator` / `/gantry:curator` / `phases/C-curator.md`
> **频率**：月度（标准）+ 季度（深度）+ 事件触发（见第 5 节）

---

## 0. 为什么需要 Curator

项目运行一段时间后必然出现：

- `LESSONS.md` 膨胀到 100+ 条，没人再读
- 多人各自写了同一主题的 knowledge，结论微妙冲突
- 3 个月前的结论被新证据推翻，但老条目还在 active
- `fast:` commit 占比悄悄从 10% 爬到 50%，没人发现在绕流程
- `CONTEXT.md` / `CONVENTIONS.md` 与代码实际约定开始漂移

Curator 是**月度低频高价值**的角色，阻止上述熵增。

**Solo 模式**：1 人项目同样需要 Curator 节奏，但去掉 1-on-1 和团队通知步骤，重点放在自己的知识库维护和漂移检测。

---

## 1. 触发条件

### 1.1 定期触发

| 频率 | 内容 | 命令 |
|---|---|---|
| 月度 | 标准 checklist（1.2~1.7）| `gantry curator` |
| 季度 | 标准 + CONVENTIONS 漂移检测 + 规则 retro | `gantry curator --quarterly` |

### 1.2 事件触发（提前触发，不等月度）

以下任一条件命中时立即触发：

- 重大发布 / 里程碑完成后
- 线上事故复盘后（事故经验必须进 LESSONS）
- `LESSONS.md` 总条目 > 80
- 新成员入职 ≥ 3 人（知识库可发现性变得更重要）
- `fast:` commit 连续 2 个月占比 > 35%

---

## 2. 月度 Checklist

### 2.1 跑 metrics（5 分钟）

```bash
gantry metrics --since "1 month ago"
```

打开 `.specs/metrics/<YYYY-MM>.md`，重点看：

- **§1** `fast:` 占比 — 有 ⚠️ 预警时重点跟（第 2.4 节）
- **§2** 作者分布 — 单人 `fast:` 占比高的人
- **§3** REVIEW.md 覆盖率 — 代表 review 阶段被跳的频率
- **§4-5** knowledge / LESSONS — 本次要整理的存量

关注**与上月的差值**，不看绝对数值。

### 2.2 整理 LESSONS（20-40 分钟）

**只做 4 件事**：

#### A. 合入"待审"区

走到 `.specs/LESSONS.md` 末尾 `## 待审` 段。INTEGRATION 阶段提名的条目都在这。

**AI 辅助审阅**（推荐）：

```
@.specs/LESSONS.md

你是 Curator。请对每条「待审」条目做判断：
1. 未来 6 个月是否会被再试 → 否则丢弃
2. 是否仅限本次 change 的特殊情况 → 是则丢弃
3. 是否与已有 L-NNN 重复 → 是则合入老条目
4. 以上都不是 → 建议分配 L-NNN 编号合入

输出格式：| 待审条目摘要 | 建议操作 | 理由 |
```

**经验法则**：提名 10 条合入 3-5 条是健康的。合入率 > 80% 说明提名太宽松，< 20% 说明提名太严。

#### B. 状态迁移

扫所有 `active` 条目，看哪些可以降级：

- `active` → `superseded`：有更新条目取代（填 `supersededBy: L-NNN`）
- `active` → `deprecated`：技术栈 / 库已更换，不再适用
- `active` → `stale`：6 个月未被任何 PROGRESS / SUMMARY 引用过

检测 stale 的命令：

```bash
# 近 6 个月 SUMMARY / PROGRESS 引用过的 L-NNN
git log --since='6 months ago' --all -p -- '.specs/**/*SUMMARY.md' '.specs/**/*PROGRESS.md' \
  | grep -oE 'L-[0-9]+' | sort -u
```

#### C. 冲突 / 重复合并

同主题 ≥ 2 条 → 保留最新，老的标 `superseded`。不要试图合并成"一条更好的"——那是重写，容易丢信号。

#### D. 更新索引

LESSONS.md 顶部索引表刷新（按状态分组），便于 grep。

### 2.3 整理 knowledge（20-40 分钟）

遍历 `.specs/knowledge/*.md`：

#### A. 状态升级

条目默认 `status: draft`。符合以下条件之一 → 升 `reviewed`：

- 有人引用过（grep `.specs/` 和 git history）
- Curator 核对过来源 / 证据等级，认为可信
- 有至少 1 条"追加"（说明被人回来补充过）

**不要为了清空 draft 而滥升 reviewed**。

#### B. 过期检测

日期 > 6 个月 + `reviewed` + 涉及外部库版本 / API → 疑似过期：

```bash
find .specs/knowledge -name '*.md' -mtime +180 -exec grep -l 'status: reviewed' {} +
```

- 引用版本仍适用 → 追加一行 `YYYY-MM-DD · 仍适用 · by Curator`
- 已过期 → 跑 `gantry knowledge <topic>` 产新条目，老条目标 `superseded`

#### C. 重复合并

同主题 ≥ 2 条 → 保留最新。

#### D. 冷启动特例

本月 knowledge 条目 = 0（metrics §4 预警）→ 必须跟进：

```
询问（自己 / 团队）：过去 30 天有没有调研 / 选型 / POC？
有 → 为什么没沉淀？
  不知道 K 通道存在 → 普及 / 分享
  觉得流程重 → 精简 K 模板（走 CHANGE 流程改 phases/K-knowledge.md）
  结论在 Slack / 笔记 → 手动补一条
无 → 不是问题
```

### 2.4 `fast:` 占比跟进（10-20 分钟）

metrics §1 有 ⚠️（`fast:` > 35%）或 §2 有人 > 55% + ≥4 commits → 跟。

**不是批评，是诊断**：

| 可能原因 | 信号 | 处理 |
|---|---|---|
| 完整流程太重 | 多人 `fast:` 占比高 | 检查 phases 是否有精简空间 |
| 大量小 bug | `fast:` 数高但总 commit 也高 | 健康，不干预 |
| 有人绕流程 | 单人占比高 + 他人正常 | Solo: 自我复盘；团队: 1-on-1 |
| 紧急 hotfix | 集中在几天内爆发 | 确认是否事故应急 |

```bash
# 某人的 fast: 列表
git log --since='1 month ago' --author='<name>' --grep='^fast:' --oneline

# fast: commit 的 diff 大小（超 50 行就是违规）
git log --since='1 month ago' --grep='^fast:' --stat | head -50
```

发现 `fast:` commit diff > 50 行 → F-fast 违规，在下次 retro 点名现象（不点人）。

### 2.5 CONTEXT / CONVENTIONS 同步检查（10 分钟）

- 扫本月新归档 change 的 `DESIGN.md § 9 架构沉淀建议`
- 如果 ≥ 3 条 architecture-level 建议未同步 → 提示跑 `gantry architect` 或 `A-evolve`
- **Curator 不自己跑 A-evolve**（那是 Architect 的工作）

### 2.6 写 month report（10 分钟）

在 metrics 报告的 "建议行动" 段填真实发现：

```markdown
## 建议行动（Curator 月度 review · YYYY-MM-DD）

### 处理完成
- LESSONS 待审 N 条 → 合入 X / 丢弃 Y
- LESSONS 状态迁移：L-023 superseded / L-017 stale / L-009 deprecated
- knowledge 升级：<list>

### 需关注
- fast: 占比 X% → <计划>
- REVIEW.md 覆盖率 X% → <发现>

### 下月关注
- <悬而未决的信号>
```

提交：

```bash
git add .specs/metrics/<YYYY-MM>.md .specs/LESSONS.md .specs/knowledge/
git commit -m "chore(curator): YYYY-MM 月度整理"
```

---

## 3. 季度深度 review（额外步骤）

在标准月度 checklist 基础上增加：

### 3.1 CONVENTIONS 漂移检测

对比 `.specs/CONVENTIONS.md` 与实际代码约定：

```bash
# 检查分支命名是否符合约定
git branch -a | grep -vE 'feat/|fix/|refactor/|chore/|docs/'

# 检查提交格式是否符合约定
git log --since='3 months ago' --oneline | grep -vE '^[a-f0-9]+ (feat|fix|refactor|docs|test|chore|fast)'
```

发现漂移 → 走 CHANGE 流程更新 CONVENTIONS.md（不要直接改代码）。

### 3.2 规则 retro（15 分钟）

扫 `RULES.md` R1~R8，问：

- 哪条规则过去 3 个月**从未触发**？→ 可能已内化，或场景不再存在
- 哪条规则**触发但被绕过**？→ 执行障碍，需要简化或加工具支撑
- 哪个新场景**当前规则没覆盖**？→ 提名新规则（走 CHANGE 流程）

### 3.3 LESSONS 全量健康检查

- 统计各状态分布（active / superseded / stale / deprecated）
- active > 60 条 → 强烈建议再做一轮状态迁移
- superseded 积累 > 30 条 → 考虑归档到 `LESSONS-archive.md`

---

## 4. 阈值（默认值）

| 指标 | 预警阈值 | 触发动作 |
|---|---|---|
| `fast:` 月度占比 | > 35% | ⚠️ 跟进是否绕流程 |
| 单人 `fast:` 占比 | > 55% + ≥4 commits | 诊断原因 |
| REVIEW.md 覆盖率 | < 65% | 检查 review 阶段是否被系统跳过 |
| LESSONS 待审积压 | > 15 条 | 本月必须清零 |
| knowledge 月度新增 | < 2 且 ≥3 次调研活动 | 推广 K 通道 |
| LESSONS 合入率 | < 20% 或 > 80% | 调整提名标准 |
| `fast:` diff 超限率 | > 10% | 加强 F-fast 入口自检 |
| LESSONS active 总量 | > 60 | 做一轮状态迁移 |

> 以上阈值是经验默认值。建议运行 3 个月后用真实分布修正，在 `.specs/CONVENTIONS.md` 的 §11 记录项目实测阈值。

---

## 5. Curator 红线

**禁止**：

- 删除 LESSONS / knowledge 条目（只改状态，历史留痕比干净重要）
- 修改他人写的条目正文（只能追加状态行 / 追加段 / 改 frontmatter）
- 自行修改 `CONTEXT.md` / `CONVENTIONS.md` / `ARCHITECTURE.md`（走对应流程）
- 用 metrics 数字做考核 / 绩效评价（metrics 是观察镜不是 KPI）
- 为美化 metrics 数字而造条目

**可以**：

- 状态迁移（active → superseded / deprecated / stale）
- 追加"追加"段（YYYY-MM-DD · 说明 · by Curator）
- 合入 LESSONS 待审区
- 在月报里做 judgement call（说现象不说人）
- 提议改 `phases/*` 或 `RULES.md`（走 CHANGE 流程）

---

## 6. 传承（角色交接）

Curator 离职 / 轮值交接时：

1. 写 `.specs/curator-handover-<YYYY-MM-DD>.md`：
   - 当前 LESSONS / knowledge 总数 + 各状态分布
   - 正在跟进的信号（如"fast: 占比连续 3 个月爬升"）
   - 上次 review 未闭合的建议
2. 与继任者共跑一次月度 review（师傅日）
3. 保留前任 1 个月随时咨询权

Solo 模式：写给未来的自己。每次季度 review 结束时写一份简短的"给下季度自己的信"。

---

## 7. 反模式

**以下行为虽看起来"尽职"，但会让知识库变糟**：

1. 把所有 LESSONS 都搬到"精选"段 → 破坏 grep 的随机发现
2. 把 knowledge 条目精修得漂亮 → 原作者的口语才是真实信号
3. 为达成指标美化条目状态 → 下月被实际失败打脸
4. 月度会议点名 `fast:` 最高的人 → 他会开始不 commit 或伪装 commit 类型
5. 自己动手合并 CONTEXT.md → 绕过 A-evolve，后面没人知道为什么这么写

---

## 8. 输出

- `.specs/metrics/<YYYY-MM>.md`（月度 metrics 报告）
- `.specs/LESSONS.md`（状态更新）
- `.specs/knowledge/*.md`（状态更新）
- `.specs/curator-handover-<date>.md`（交接时）
