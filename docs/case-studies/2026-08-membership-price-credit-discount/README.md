# Case Study — membership-price-credit-discount

> 一次真实 gantry full-pipeline 会话的复盘,用于驱动框架迭代。

## 索引

- [`DIAGNOSIS.md`](./DIAGNOSIS.md) — 会话诊断:量化信号、规则违背对照、卡点、多维根因
- [`EFFICIENCY-COMPARISON.md`](./EFFICIENCY-COMPARISON.md) — 用 gantry vs 不用 gantry:执行效率、工具链、成本诚实归因、决策指引
- [`IMPROVEMENT-PLAN.md`](./IMPROVEMENT-PLAN.md) — 按 P0/P1/P2 优先级的框架改善计划

## 元信息

| 项 | 值 |
|---|---|
| Session | `84d39b63-1d34-4eaa-8724-d132698bf651` |
| 项目 | `ott/ai-tool`(gantry 的使用方,非框架仓库) |
| change | `membership-price-credit-discount` · pipeline=full |
| 时间跨度 | 2026-08-03 06:19 → 08-06 03:27(约 2.5 个工作日) |
| 会话规模 | 12306 行 / 26MB · 2502 条 assistant · ~113 条用户文本 |
| 分析日期 | 2026-08-06 |

## 一句话结论

流程本身走完了(change→…→收尾),但代价是 **43 次失控上下文压缩 + 7 个反复 PATCH + 1 次资损级假绿**。
根因不是执行不努力,而是 **gantry「工件即上下文」的假设与「架构决策实际发生在对话里」的现实之间存在结构性缺口**,叠加单线性状态机无法承载「多子特性 + 中途重构」的真实复杂度。

## 保存位置说明

本目录位于框架仓库的 `.gantry/`,该路径已被 `.gitignore`(第 31 行)忽略,**不进版本库**。
如需团队共享此复盘,应移到 `docs/` 或 `proposals/` 下并纳入 git。
