# CONVENTIONS · 项目约定

> 本文件是**样板**。`gantry init` 会把它复制到目标项目 `.gantry/specs/CONVENTIONS.md`，请按实际项目填充。
> 写完后它就是 Gantry 给 AI 的"项目专属上下文"，每个阶段都会加载。
>
> **与 CONTEXT.md 的边界**：
> - `CONVENTIONS.md` = 编码风格 / 分支策略 / PR 门槛 / 团队规范（**人和团队的约定**）
> - `CONTEXT.md` = 术语表 / 已锁技术决策 / 禁动清单 / 既有抽象索引（**AI 实施时的约束**）
> 有疑问时：影响 AI 写代码的放 CONTEXT；影响人如何协作的放 CONVENTIONS。

---

## 1. 技术栈默认

- 后端语言 / 框架：__（如：Go 1.22 / Kratos v2）__
- 前端语言 / 框架：__（如：TypeScript / React 18 / Next.js 14）__
- 数据库：__（如：PostgreSQL 15 / Redis 7）__
- 基础设施：__（如：K8s / ArgoCD / GitHub Actions）__

---

## 2. 命名与代码风格

- 仓库命名：__（如：kebab-case）__
- 包 / 模块命名：__
- 函数 / 变量命名：__（如：Go camelCase / TS camelCase）__
- 文件命名：__
- 注释语言：__（中文 / 英文 / 混合）__

---

## 3. 分支与提交

- 默认分支：`main`
- 功能分支：__（如：`feat/<change-id>`）__
- 提交格式：`<type>(<change-id>): <subject>`（type: feat/fix/refactor/docs/test/chore/fast）
- PR 必须：__（如：1 个 Reviewer + CI 绿 + 产物完整）__

---

## 4. 覆盖率与质量门槛

- 单元测试覆盖率：__% 以上
- 集成测试：__
- 性能基线：__（如：P99 < 200ms）__
- 安全扫描：__（如：trivy / snyk / 无）__

---

## 5. API 约定

- 协议：__（如：REST / gRPC / GraphQL）__
- URL 命名：__（如：kebab-case，`/user-profiles` 而非 `/userProfiles`）__
- 版本策略：__（如：URL 前缀 `/v1/`、Header `X-API-Version`、无版本）__
- 错误码规范：__（如：HTTP 状态码 + `{ code, message, data }` 信封）__
- 分页约定：__（如：`page + page_size` / `cursor` / `offset + limit`）__
- 幂等要求：__（如：PUT 必须幂等，POST 允许重复提交时的处理方式）__

---

## 6. 测试约定

- 测试文件命名：__（如：`*.test.ts` / `*_test.go` / `test_*.py`）__
- describe/it 命名：__（如：`describe('UserService', () => { it('creates user when...') }`）__
- Fixture / Mock 边界：__（如：禁止 Mock 数据库层，只 Mock 外部 HTTP 调用）__
- 测试数据隔离：__（如：每个 test case 独立 seed，不共享全局状态）__
- 集成测试环境：__（如：Docker Compose / TestContainers / 共享测试库）__

---

## 7. 错误处理约定

- 错误包装：__（如：`fmt.Errorf("op: %w", err)` / `new Error('context', { cause: err })`）__
- 日志级别规则：__（如：可恢复错误用 WARN，需告警用 ERROR，调试用 DEBUG）__
- Panic / 未捕获异常策略：__（如：顶层 recover，写 ERROR 日志后返回 500）__
- 用户可见错误：__（如：业务错误暴露 message，技术错误只暴露 code）__

---

## 8. 禁动清单

- __（如：禁止直接改 `pkg/common/` · 需求必须走 Architect review）__
- __（如：禁止在 feature 分支直接修改 DB migration）__
- __

---

## 9. 既有抽象索引（示例）

| 需求 | 用什么 | 在哪 |
|---|---|---|
| 日期格式化 | `pkg/time/format.go` | `FormatDate / ParseDate` |
| HTTP 客户端 | `pkg/httpclient` | `New(ctx, opts)` |
| 日志 | `pkg/log` | `log.Ctx(ctx).Info()` |
| ... | ... | ... |

---

## 10. 团队联系

- Curator（月度知识库整理）：__
- Architect 评审：__
- 紧急 rollback 联系人：__

---

## 11. 约定维护节奏

- 每季度 review 一次，发现漂移用 `/gantry-knowledge curate --quarterly` 触发检查
- 更新必须走完整 CHANGE 流程（不走 F-fast）
- 新人入职时必须通读并签字确认理解
- 上次 review：__（填日期）__
