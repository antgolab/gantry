# Gantry 功能地图 & User Tours

> 面向使用者:先看功能地图理解能力边界,再按 User Tour 选一条适合当前场景的走法。
> 判定原则:改 <30 行一次性脚本直接让 AI 改;≥100 行 / 团队 / 长期维护才上完整流程。

---

## 功能地图

```
┌─ 核心状态机(主管线 · 一条 change 顺序走完) ───────────────────────┐
│  PROPOSAL → SPEC → DESIGN → [UI-DESIGN] → TASKS → DEV → TEST → REVIEW → INTEGRATION │
│  命令: /gantry-change · /gantry-next · /gantry-exec · /gantry-archive           │
├─ 状态与恢复 ──────────────────────────────────────────────────────┤
│  /gantry-status(查状态) · /gantry-resume(断点恢复)                 │
│  /gantry-adjust(变更补丁 PATCH) · /gantry-unarchive(恢复归档)      │
├─ 横向能力(按需调用 · 不推进主管线) ──────────────────────────────┤
│  项目上下文: /gantry-context scan | architect | evolve              │
│  知识库:     /gantry-knowledge capture | curate                     │
│  审查:       /gantry-review [--requirement | --adversarial]         │
│  诊断快修:   /gantry-health · /gantry-debug · /gantry-fast          │
├─ 自动化与统一入口 ────────────────────────────────────────────────┤
│  /gantry-auto(人工确认关卡下自主推进)                           │
│  docs/GO.md(自然语言统一入口,自动判断阶段)                        │
└────────────────────────────────────────────────────────────────────┘
```

三层交互模式并存:**IDE 斜杠命令**(日常主路径)、**CLI 状态机**(脚本 / CI)、**@引用**(任何支持 @ 的工具的通用回退)。

---

## User Tours

### Tour 1 · 新功能完整闭环(主力场景,>100 行)

```
gantry change "给订单列表加导出功能"
/gantry-next         # → SPEC.md
/gantry-next         # → DESIGN.md
/gantry-next         # → TASKS.md
/gantry-exec         # → DEV(逐任务在 fresh context 循环)
/gantry-next         # → TEST
/gantry-next         # → REVIEW
gantry archive       # → INTEGRATION + 归档
```

适合:团队协作、要可追溯制品、长期维护。典型 ~150k–300k token(中型 feature)。

### Tour 2 · 极简模式(当天跑通,30–100 行)

```
gantry change "描述需求"
/gantry-next   # 只到 SPEC + TASKS
/gantry-exec
```

产物 SPEC.md + TASKS.md + EXECUTION.md,跑顺后再升级完整版。

### Tour 3 · 老项目首次接入(Brownfield)

```
/gantry-context scan       # 扫代码生成 CONTEXT.md,识别既有架构 / 抽象 / 禁动清单
gantry change "加功能"     # 之后正常走 Tour 1 / 2
```

护栏目标:防 AI 写出格格不入的代码、防重复实现既有抽象、防乱删乱改。

**若项目已有分层知识库 `.context/`(rules/knowledge/practices + MANIFEST):**
- `scan` 探测并对接 `.context/MANIFEST.md`,不覆盖团队维护的知识。
- **TASKS 阶段**:命中团队约定(如「查 MySQL 走 btsgen 缓存回源」)时,把正确路径写进 `action`、产物文件锁进 `write_files`——走错路即越界,被提交前 R6.5 边界 verify 拦住。
- **DEV 阶段**:默认不重读 MANIFEST(TASK 已查过),直接读锚定结果 + `read_files` 里的黄金范例照抄;仅未锚定任务才兜底查。
- gantry 只通过 MANIFEST 这一个接口消费,**不复制知识**;无 `.context/` 时优雅回退到原生 LESSONS/CONTEXT。

### Tour 4 · 单点能力(不走全流程)

| 想要 | 走法 |
|---|---|
| 只做 code review | `/gantry-review` 丢一段 diff |
| 只做代码库体检 | `/gantry-health` |
| 系统化调试 | `/gantry-debug` |
| 只理顺一个想法 | `phases/0-change.md` |
| 只沉淀失败教训 | 往 `.gantry/specs/LESSONS.md` 加一条 |
| <50 行快速闭环 | `/gantry-fast` |

### Tour 5 · 长期维护节奏(月度 / 季度)

```
/gantry-knowledge curate       # 整理 LESSONS / knowledge:合入待审、状态迁移、去重
/gantry-context evolve         # 扫近期 change 的 DESIGN §9,同步项目级架构沉淀
```

事件触发(不等月度):重大发布后、线上事故复盘后、LESSONS > 80 条、`fast:` commit 占比异常。

---

## 选择指南

| 你的场景 | 推荐 Tour |
|---|---|
| 改 < 30 行 / 一次性脚本 | 都不用,直接让 AI 改 |
| 30–100 行 / 个人项目 | Tour 2 极简 |
| >100 行 / 团队 / 要制品 | Tour 1 完整 |
| 接手老项目 | Tour 3 先 scan |
| 只需某一项能力 | Tour 4 单点 |
| 项目已跑一段时间 | Tour 5 定期维护 |
