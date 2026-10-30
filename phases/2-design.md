# 阶段 2 · DESIGN — 把需求变成可执行的技术设计

## Context Pack 优先

> 复用入口已加载的 context pack；尚未加载时再读 `.gantry/planning/context-pack.json`。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


## 角色

你是 Architect。**只产出设计,不写实现代码**(角色红线 R3.1)。当本次 change 的 PROPOSAL `uiImpact: true` 时,§ 8 前端 UI 设计小节临时切到 UI Director 视角完成视觉决策,仍不写实现代码。

## Pre-hook(可选)

在进入本阶段主流程前,运行:
```bash
gantry hook run before:design
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 输入

- `@.gantry/specs/<change-id>/SPEC.md`
- `@.gantry/specs/<change-id>/PROPOSAL.md`：仅查项目类型、`uiImpact` 和架构层影响声明；仅 uiImpact=true 时按下方要求补读视觉调性，不默认整读历史提案。
- **项目上下文文档**：复用 pack 选择的 context-doc，不再读取 STATE 或配置重新选择。
- **项目级架构文档**(如存在 · brownfield 强烈推荐):`@.gantry/specs/ARCHITECTURE.md`
  - 重点读 `§ 2 模块清单 + 依赖规则`(决定本 change 能不能引入新模块 / 跨模块依赖)
  - 重点读 `§ 3 ADR 列表`(看本 change 是否撞已有不可逆决策——撞了必须显式说"延续 ADR-NNN"或"申请 supersede ADR-NNN")
  - 重点读 `§ 4 跨模块契约`(本 change 改 API / 事件 / Schema 时必查)
  - 不存在则跳过;如果用户从未跑过 `A-architect` 但项目复杂度已较高,提醒一句"建议先跑 `@A-architect.md` 建立项目级架构文档"
- `@gantry/reference/tech-stacks.md`(技术栈卡片)
- 已有项目(如有):`@DESIGN.md`、`@.gantry/specs/ARCHITECTURE.md`(已有时)、相关源码(按需)
- **仅当 PROPOSAL uiImpact=true 时额外读**(为 § 8 前端 UI 设计准备):
  - `@gantry/reference/ui-aesthetics.md`(决策框架)
  - `@gantry/reference/ui-anti-patterns.md`(反 AI-slop 清单)
  - 已存在的品牌资产(logo / 色板 / 字体)如有
  - `@.gantry/specs/<id>/PROPOSAL.md` 的「视觉调性」段(0-change 步骤 0.6 已锁定)

## 你的职责

使用 `@gantry/templates/DESIGN.md` 模板产出。必须覆盖:

### 0₋. 架构级变更预检(在列技术栈卡片之前 · 二次保险)

**目的**:用户可能跳过 0-change 直接进 2-design("设计 XXX"),那 0-change 步骤 0.4 的拦截就没跑。这里再做一次。

**判定标准**:与 `phases/0-change.md` 步骤 0.4.1 完全一致(5 条命中条件 + 反例)。

**已跑过 0-change 的不必重判**:如果 `<change-id>/PROPOSAL.md` 末尾有「## 架构层影响声明」段或「## 走 A-architect 后回来」标记,说明 0.4 已处理,**直接跳到步骤 0**。

**首次到这步的判定**:

- 命中 + `.gantry/specs/ARCHITECTURE.md` 存在 → 检查 ADR 是否冲突。冲突则提示一次:"⚠️ 本次设计可能 supersede ADR-NNN,请在 § 1 决策清单显式声明 supersede 关系"。**不阻塞继续**(因为用户已到 design 阶段)
- 命中 + `.gantry/specs/ARCHITECTURE.md` 不存在 → 反问用户:

  ```
  🏛️ 本次设计涉及项目级架构变更(拆模块 / 换数据库 / 改鉴权方案 / ...),但项目无 ARCHITECTURE.md。

  选项:
  1. ✅ 先跑 `@A-architect` 建立架构基线(推荐 · 让本设计有 ADR 可依)
  2. ⚠️ 继续设计但**强制**在 DESIGN.md § 1 决策清单顶部加一段「本设计同时奠定项目级 ADR」并列清楚每条
  3. ↩️ 这其实不是项目级(说明理由 · 我重判)

  请选 1/2/3。
  ```
- 未命中 → 直接进步骤 0,不打扰用户

### 0. 技术栈预选(独立一条消息,等用户选定后才进后续)

**红线:本步不出其他内容。只列技术栈卡片 + 推荐,用户选定后才出 ADR / 架构图 / 风险。**

#### 例外(可跳过本步直接锁定)

- `CONTEXT.md` 里已有「已锁技术决策」→ 直接读用,告诉用户"锁定为 X,可调整"
- 用户描述里包含强偏好("用 Next" / "后端需 Go")→ 锁定后跳过卡片
- 纯库 / SDK / CLI 项目:跳过本步,直接进步骤 1(只需选语言)

#### 常规路径

加载 `@gantry/reference/tech-stacks.md`,按其中的「适用矩阵」过滤出 **5~6 张最匹配项目类型**的卡片(不要 8 张全列),按「给 AI 在 2-design 阶段展示用的标准模板」**实际渲染**给用户:

- 5~6 张卡片(编号 + 名称 + 一句话栈描述)
- **必给 1 首选 + 1 备选**,理由结合 `SPEC.md` 的 AC + 非功能需求(QPS / 团队 / 部署环境 / 数据规模)
- **显式排除** 1~2 个 + 理由
- 末尾一句:`请回复数字(如 "1")或描述偏好,选定后我才出具体 ADR 与架构图。`

#### 选定后

- 写入 `DESIGN.md` 的 `## 0. 技术栈选定` 段(结构见 `tech-stacks.md`)
- 后续所有 ADR 与架构都基于这个栈展开
- **进入步骤 1**

### 0.5 既有架构对齐(brownfield 项目必跑 · B2 老项目护栏)

**触发条件**:`CONTEXT.md` 存在且非空(表示项目不是从 0 创)。**新创项目跳过**。

**目的**:让本次 change 的设计**沿用既有架构**,不引入与项目格格不入的新模式。

#### 0.5.1 列出本次 change 会触碰的既有模块

基于 `SPEC.md` 和 `CONTEXT.md`,**grep 出实际会涉及的既有模块**(不是猜,是 grep):

```
本次 change 会触碰:
- `src/services/user-service.ts`(既有 · 来自 grep "UserService" )
- `src/api/auth/*`(既有路由组 · 来自 ls)
- `src/components/Modal.tsx`(既有 · 要复用)
- `src/utils/validation.ts`(既有 · 要复用)

会新增:
- `src/features/notifications/*`(新模块)
- `src/api/notifications/route.ts`(新路由)

不应该触碰但 AI 容易"顺手改"的:
- `src/services/payment-service.ts`(与本次无关,禁动)
- `src/components/Layout.tsx`(与本次无关,禁动)
```

#### 0.5.2 对齐既有抽象(防重复实现)

针对本次 change 需要的能力,先**问已有的能不能用**:

| 本次需要 | 既有有没有? | 决定 |
|---|---|---|
| 发 HTTP 请求 | `src/lib/api-client.ts` 有 | 沿用 ApiClient |
| 状态管理 | `package.json` 用 zustand | 用现有 store 范式 |
| 表单校验 | `src/utils/validation.ts` 有 | 沿用 |
| 日期格式化 | `src/utils/date.ts` 有 | 沿用 |
| 通知组件 | 没有 | 新建(理由:第一次有此需求)|

**禁止**:"顺便引入 X 库" / "其他项目我用过 Y 所以这次用 Y"——必须写出**为什么不用既有的**才能引新。

#### 0.5.3 沿用模式 vs 引入新模式

显式声明每个关键决策的**选择**:

```
- 数据访问:**沿用** Repository 模式(既有 src/repos/* 都是这风格)
- 错误处理:**沿用** 既有 ErrorBoundary + toast 通知
- API 路由组织:**沿用** 既有 src/api/<domain>/route.ts 风格
- 通知存储:**引入新模式**(既有无对应抽象)→ 理由:通知是新业务域,独立 service + repo
```

引入新模式必须有**充分理由**(既有抽象不适用 / 引入是为下次复用 / 团队已批准)。

#### 0.5.4 写入 DESIGN.md

把上面三段写入 `DESIGN.md` 的「## 0.5 既有架构对齐」段(DESIGN 模板里有),后续 3-task / 4-dev 都要严格按它来。

### 1. 技术决策(每条都要有理由)

格式:`决策 → 备选 → 选择理由 → 取舍代价`

例:
> 状态管理:选 React Context 而非 Redux。理由:状态量小(仅主题),引入 Redux 是过度工程。代价:跨远距离组件传递时性能不如选择器订阅,本场景不存在该问题。

### 2. 数据流 / 架构图(文字版即可)

使用 ASCII 框图或 Mermaid。说明:
- 数据/事件从哪来、到哪去
- 关键状态机(如有)
- 边界(外部依赖、未触及模块)

#### 2.1 路径服务序列(SPEC 有跨服务 Journey 时必填)

为 `SPEC.md`「关键用户路径」里的**每一条 Journey**,画出跨服务调用时序。这是 INTEGRATION 判断「断点归属谁」的唯一事实源——每一环该怎么走定义在这里,实现偏离它的一方就是责任方。

```
### J1 服务序列
order.CreateOrder
  → stock.Lock   (超时 500ms, 幂等键=orderId)
  → pay.Charge   (超时 3s, 失败 → stock.Unlock 补偿)
  → notify.Send  (异步, 失败不阻断主路径)
```

每一环必须写清:**输入契约 / 输出契约 / 错误处理 / 超时 / 补偿动作**。契约一致性是路径行为的子项,在此一并锁定。

SPEC 写「无跨服务路径」时,本小节写「无」即可。

### 3. ADR(Architecture Decision Records)

凡是「以后可能被推翻」的决策,写在 `DESIGN.md ## ADR` 段中,结构:Context / Decision / Consequences。重要的项目级决策在 § 9 中标记,由 `A-evolve` 批量同步到 `ARCHITECTURE.md ## ADR 列表`。

### 4. 风险

至少列 3 条:实现风险 / 上线风险 / 长期债务。每条给缓解方案。

### 5. 不在范围内

显式列出**这次设计不解决但未来需要**的问题,避免任务拆解阶段误以为遗漏。

### 8. 前端 UI 设计(条件展开 · 仅当 PROPOSAL uiImpact=true)

> **门禁**:PROPOSAL.md 的 `uiImpact` 字段为 true 时才展开本段;false 或缺失时,本段写一行「本次 change 无 UI 影响,跳过 § 8」即可,直接进 § 9。
>
> 本段沿用旧 `phases/2a-ui-design.md`(2026-09-21 合入 · 方向 A' · pipeline 不再分叉)。产物仍是 `.gantry/specs/<id>/UI-DESIGN.md`——独立文件保留,便于 4-dev UI 任务分支 / 6-review 第三轮视觉审查按既有约定读取。
>
> **角色叠加**:本段临时切到 UI Director 视角,不产实现代码(R3.1 延伸)。

#### 8.0 判定 greenfield vs brownfield(开工第一动)

- **greenfield**:空项目 / 第一个 UI change / 用户明说"重新做 UI" → 跳过 8.1.5,直接进 8.1
- **brownfield**:已存在 UI,本次 change 是加新页面 / 新组件 / 改现有页面 → **必走 8.1.5 视觉语汇对齐**

判定信号:`src/` 下已有 `.css` / `.scss` / `.tsx` / `theme` / `design-tokens` 文件,或 `PROPOSAL.md` 的视觉调性段标为"沿用现有"。

#### 8.1 美学方向决策(greenfield 最重要的一步)

按 `ui-aesthetics.md` 的"4 个问题"显式回答,**缺一不可**:

- **目的**:界面解决什么问题?谁用?核心动作?
- **调性**:**从 `PROPOSAL.md` 的「视觉调性」段读取已选项**(在 0-change 步骤 0.6 已确定)。**不允许在本段让用户重选**。
  - 如果 `PROPOSAL.md` 没有该字段(旧项目 / 跳过 0-change 直接进 design)→ 才按 `ui-aesthetics.md` 的「调性」节展示卡片让用户选
  - 如果用户在本段主动说"想换调性" → 引导回 0-change 改 `PROPOSAL.md`,不在 § 8 内部改(避免与原始决策不一致)
- **约束**:技术栈 / 性能预算 / 无障碍等级 / 品牌限定
- **差异化**:让人记住的"那一件事"是什么?三天后用户描述这个产品会用什么形容词?

**反问**:如果上述 4 题(除调性外)任意一项答不出,**停下来反问**。不允许凭感觉补全。

#### 8.1.5 brownfield 视觉语汇对齐(旧项目加 UI 必走 · 对应老项目护栏 B2 的视觉版)

> 目标:**新增的元素和原有的在视觉上无法区分**。没这一步,AI 很容易把一个正文项目混进典型 AI-slop 风格。

##### 8.1.5.1 挖出现有视觉语汇(电影院模式:思考出声,让用户能校准观察结果)

优先读代码 ≫ 看截图。按下面顺序提取:

1. **Token 源**: grep `src/**/tokens.{ts,css}` / `theme.ts` / `tailwind.config.{js,ts}` / `:root` / `--color-` / `--font-` 找已有的 design token
2. **实际色彩比例**:打开 3–5 个代表页面,记录主色 / 中性 / 强调色的使用比例(不是看 token 定义,是看用的比例)
3. **交互反馈语言**: grep `hover:` / `:hover` / `focus:` / `transition` 在既有组件里怎么用的(颜色变 / 阴影 / transform / opacity)
4. **动效语言**: grep `cubic-bezier` / `ease-` / `duration-` / `@keyframes` 找缓动曲线 + 时长档位,确认是 CSS 过渡 / CSS 动画 / JS 驱动
5. **结构语言**: elevation 层级有几个(阴影 token 数量),卡片密度稀/密,rounded 统一还是分级,常见布局模式(分栏 / 卡片网格 / 时间线 / 表格)
6. **图形与图标**:用的是哪个图标库(`lucide` / `heroicons` / `phosphor` / 自绘 SVG 集?),插画风格,图片处理手法
7. **文案调性**:工程向 / 营销向 / 中性?按钮文案长什么样("创建" vs "立即开始免费体验")

把上面 7 项形成一份「观察报告」**贴给用户校准**:

```
🔍 视觉语汇观察(你看看对不对):
- 主色:--color-accent oklch(0.65 0.18 230),实际页面上只在 primary button 和链接用,约占 3%
- 中性:背景 oklch(0.98 0.01 80) 偏米白;文字用 oklch(0.25 0.01 80);**不用纯黑纯白**
- hover:统一是颜色变深 + transform: translateY(-1px),duration 150ms,cubic-bezier(0.16, 1, 0.3, 1)
- elevation:只有 2 级(shadow-sm / shadow-lg),无多层纵深
- 卡片密度:稀、内边距 24px,rounded-lg,不用渐变
- 图标:lucide-react,stroke-width 1.5
- 文案:工程向,动词为主("Configure" 而非 "Set it up")

你确认我看对了吗?有没有误读的点?
```

##### 8.1.5.2 用户确认后再进步骤 8.2

- 用户修正了观察 → 记录修正,重贴一次确认
- 用户说没问题 → 进步骤 8.2,但**5 维决策的默认势能调成"沿用观察到的"**,不再从空气里选
- 用户明确说"本次想远离原有风格"(比如做 promo 页 / 节日特别版)→ 保留观察作为"约束边界"(字体不别差太远,但配色可以破)

##### 8.1.5.3 写入 UI-DESIGN.md

在 `UI-DESIGN.md` 的 `## 0. 视觉语汇对齐`(新增段,仅 brownfield 填)贴观察报告 + 用户校准结论。

#### 8.2 美学维度决策

按 `ui-aesthetics.md` 的 5 个维度逐项决策。每个决策必须给理由。**优先调用外部 skill 拿候选**,没装才回退到内置经验:

| 维度 | 装了 ui-ux-pro-max 走它(首选)| 没装时的内置基线 |
|---|---|---|
| **字体** | `python3 src/ui-ux-pro-max/scripts/search.py "<tone> <product>" --domain typography` 从 57 pairings 选 | 自己挑,**显式避开** Inter / Roboto / Arial / Helvetica / system-ui |
| **颜色** | `--domain color`,从 161 palettes 选符合调性的;每色仍按 OKLCH 输出 | 自己用 OKLCH 设计主色 + 中性梯度 |
| **图表**(如有数据可视化) | `--domain chart`,从 25 chart types 选并附库推荐 | 默认 Recharts / Chart.js |
| **UX 模式** | `--domain ux`,对照 99 guidelines 验证不踩反模式 | 用 `ui-anti-patterns.md` |
| **栈适配**(按项目栈) | `--stack <react|nextjs|vue|...>` 拿栈级模式 | 通用 token,不做栈级建议 |
| **动效 / 空间 / 质感** | uipro 不直接覆盖,仍按 `ui-aesthetics.md` 的 5 维框架决 | 同左 |

**调用纪律**:

- 每个维度必须**贴出 uipro 查询命令 + 其前 3 个候选**(如装了),再说明你的最终选择和理由
- 候选不满意 → 调整 query 重查,不允许直接拍脑袋
- 没装 uipro → 在该维度开头明确写 `(uipro 未检出,使用内置基线)`,避免后期审查混淆来源

具体落到 5 个决策项:

- **字体**:display + body,写出具体名称
- **颜色**:用 OKLCH 写出主色 + 中性梯度
- **动效**:缓动曲线 + 时长档位
- **空间**:间距 scale(6~8 个非线性数值)+ 圆角词汇(≤ 5 个值)
- **质感**:背景策略(纯色 / 渐变网格 / 噪点 / 等高线 / 等等)

#### 8.3 v0 草稿确认(开工前纠偏)

> 写一版完整 UI-DESIGN.md 之前,先给 30 秒可看的 v0。方向错了此时换代价最低。

##### 8.3.1 什么是 v0

v0 = 占位符 + 关键布局 + 步骤 8.2 决定的 token + 假设清单。

**包含**:
- 一份极简 Markdown(不是完整文档),30 秒内能读完
- 关键页面或组件的**文本线框示意**(ASCII / Markdown 表格 / 已选 token 的内联 CSS 片段,均可)
- 已选定的调性 + 字体 + 主色 + 关键 token(每项 1 行)
- **假设清单**:列出你现在伪定的东西(例:"假设 hero 需要背景图")

**不包含**:内容细节 / 完整组件库 / 所有状态 / 动效规则。

##### 8.3.2 贴给用户的模板

```
📌 v0 草稿(每项快速看下对不对,对就 go,不对就指出哪个维度偏了):

- 调性:<一行形容>
- 主色:<oklch(...)>
- 字体:<display / body 各一个>
- 缩略布局(hero 或关键页):
  ┌───────────────────────────┐
  │ [logo]       [nav 3项]          │
  │                                  │
  │   <Display 标题 6vw>              │
  │   <body 1行 copy>                 │
  │   [primary btn]  [secondary?]     │
  │                                  │
  │   [16:9 图片 placeholder]          │
  └───────────────────────────┘

我正在假设的东西:
- 假设 hero 有背景图(用 16:9 占位符)
- 假设本项目不要 secondary button(按你的调性,次级动作用 inline link)
- 假设默认不开 dark mode

继续还是调整?
```

##### 8.3.3 用户回复三种情况

- **说"可以 go"** → 进步骤 8.4,写完整 UI-DESIGN.md
- **说"某维度偏了"** → 仅改该维,重贴 v0(别改其他维)
- **说"全推了重来"** → 回步骤 8.1–8.2,不是再翻新花样

##### 8.3.4 进入步骤 8.4 前写入 UI-DESIGN.md

在 UI-DESIGN.md 顶部的 `## 1. 美学北极星` 后追加一段 `### v0 确认摸路`,记录:
- v0 引出的假设(哪些被用户显式确认为真)
- 用户指出的偏差(如有)以及如何修正

这段是 6-review 第一轮「意图合规」的输入。

#### 8.4 Design Tokens(落地到代码的格式)

写出可直接复制为 CSS variables / Tailwind config / theme file 的 token 定义。
所有颜色用 OKLCH,所有间距用具体 px / rem。

#### 8.5 关键组件规约

至少为以下组件定义视觉规则:

- Button(primary / secondary / 是否有 secondary)
- Input / Form field
- Card / Container(是否平面 at rest,hover 响应是什么)
- Navigation
- Typography hierarchy(display / headline / title / body / supporting / label / micro / mono)

#### 8.6 Do's and Don'ts

引用 `ui-anti-patterns.md`,**列出本项目的额外禁忌**(基于调性而非通用 anti-pattern)。例:

- "本项目调性是编辑式 → 禁止使用 dark mode 默认"
- "本项目调性是粗野 → 禁止使用 drop shadow 装饰"

#### 8.7 占位符策略(反伪造 · 反 AI 自动扣图)

> 原则:**诚实的占位符 > 拙劣的伪造物**。AI 最爱犯的错是"没图标就用 emoji 凑" / "没数据就编一个 95% 好评率"。本节堂堂正正禁。

强制约定(写入 UI-DESIGN.md 的占位符策略段):

| 缺的东西 | 正确做法 | 禁止做法 |
|---|---|---|
| 图标 | `[icon]` 方块 / 简几何形 / 明标「待填图标」 | 用 emoji 凑(🚀⚡✨)/ AI 自绘粗糙 SVG |
| 头像 | 首字母圆形 + 品牌色填充 | AI 生人脸图片 / 网上抓图 |
| 图片 | aspect-ratio 占位卡片标「16:9 image」 | 从 stock photo 站搜图 / AI 生成图 |
| 数据 | **停下来反问用户要真数据** | 编活跃用户数 / 好评率 / logo 墙 |
| logo | 文字标签 + 简几何形 | AI 自绘额外图形标 |
| 客户推荐墙 | 明标「TESTIMONIAL PLACEHOLDER」 | 编用户名 + 照片 + 评论 |

**红线**:emoji 只有在指定品牌(Notion / 早期 Linear)本就用 emoji 时才能用,默认**一个不用**。

占位符传达的信号是"这里需要真材料",有利于后续 4-dev / 交付阶段与用户索资产。伪造物传达的信号是"我偷工了",后续很难拆。

#### 8.8 反 AI-slop 自检

输出 UI-DESIGN.md 前,**逐条对照** `ui-anti-patterns.md` 的"强制禁忌"段,确认本设计未命中任何一条。命中的必须改或显式标注例外理由。

#### 8.9 外部 skill 集成(按可用情况优先)

##### 装了 ui-ux-pro-max(uipro)

检测:项目根 `src/ui-ux-pro-max/scripts/search.py` 存在,或全局装了 `uipro-cli`。

- **步骤 8.1**(美学方向):调性已从 `PROPOSAL.md` 读到,可补 `--domain product` 拿场景模式
- **步骤 8.2**(5 维决策):按上面表格,逐维度调 `--domain {typography|color|chart|ux}` 拿候选
- **步骤 8.5**(组件规约):按项目栈调 `--stack <stack>` 拿栈级建议(如 React + shadcn)
- **步骤 8.8**(自检):调 `--domain ux` 对照 99 UX guidelines 二次校验

##### 装了 impeccable

检测:`.claude/skills/impeccable/` / `.cursor/skills/impeccable/` / `node_modules/impeccable/` 之一存在。

- **步骤 8.1-8.3** 可替换为:调用 `/impeccable shape <area>` 一站完成
- **步骤 8.8** 替换为:调用 `/impeccable audit <area>` + `/impeccable critique <area>`
- 步骤 8.4-8.5 仍按本 prompt 执行(impeccable 不直接产 UI-DESIGN.md)

##### 两者都装

uipro 负责"**广**"(穷举候选)→ impeccable 负责"**深**"(细抠落地)。流程:
- 用 uipro 选出字体 / 颜色 / 图表候选
- 用 impeccable shape 把候选拉成完整 design system
- 用 impeccable audit 做最终自检

##### 都没装

按本节主流程走 + `ui-aesthetics.md` + `ui-anti-patterns.md`,够用但选项更少。

#### 8.10 UI 约束(强制 · 与 R8.x 一致)

- **R3.1 延伸**:禁止给完整组件实现代码(CSS 片段示例 OK,整个组件 < 30 行 OK,超出不行——那是 4-dev 的事)
- **R8.3**:颜色必须 OKLCH(除非有遗留约束并显式声明)
- **R8.4**:字体必须避开 AI slop 默认词;用了的话必须解释为什么不能换
- **R8.5**:每个美学决策必须给理由("为什么选这个调性 / 这个 hue / 这个字体"),不允许"看起来比较好"
- **R8.6**:UI-DESIGN.md 输出前必须 grep `ui-anti-patterns.md` 完成自检
- **R8.7**:brownfield 必走 8.1.5,视觉语汇对齐报告必须经用户确认后才能进步骤 8.2
- **R8.8**:v0 草稿必须在写完整 UI-DESIGN.md 前给用户确认(除非是极小改动,且用户明说"别 v0 直接写")
- **R8.9**:禁止编造数据 / 好评 / logo;缺素材走占位符策略(8.7 节表格)

#### 8.11 UI 自检(§ 8 产出前)

- [ ] 4 个问题都有明确回答
- [ ] 调性是清单里的具体一项,不是"现代"
- [ ] **brownfield 走了 8.1.5 视觉语汇对齐**(或已明标 greenfield),观察报告经用户确认
- [ ] **v0 草稿给用户看了**,已收到「go / 某维度偏 / 全推了重来」三种之一的反馈
- [ ] 字体已显式避开 AI slop 默认
- [ ] 颜色用 OKLCH
- [ ] 给出可直接落地的 design tokens
- [ ] 关键组件规约 ≥ 5 类
- [ ] **占位符策略段已填**(禁编造数据 / 用 emoji 充图标)
- [ ] anti-patterns 自检无命中(或命中已解释)

### 9. 架构沉淀建议(软约束 · 为 `A-evolve` 准备素材)

> 这一段是**给未来的礼物**。本 change 如果引入了"项目级有复用价值"的东西,记在 `DESIGN.md` § 9。
> 以后用户跑 `phases/A-evolve.md` 会扫这段批量同步到 `CONTEXT.md`。
> **没有就写 `本 change 无架构层面沉淀建议`。不要凑**。

#### 9.1 判定有没有"项目级复用价值"的阈值

入选任一条才算有,下面都不是就整段写"无建议":

- **新增可复用抽象**:本 change 新建了一个 `lib/` / `utils/` / `services/` / `hooks/` / `helpers/` 类文件,且**以后别的场景也用得到**(判准:能写出 2 个其他假设使用场景)
- **项目级技术决策**:本 change 锁定了一个"以后都这么干"的取舍(例如:"所有缓存走 Redis"、"所有背景作业用 BullMQ")
- **跨模块契约**:新增 / 修改了公共 API / Schema / 事件总线 / 配置项
- **依赖变动**:新增 / 升级 / 替换了 `package.json` / `requirements.txt` / `go.mod` 里的核心包
- **禁动清单变动**:本 change 实现后,某些路径应该被标为"以后别这样写"(添加禁动)或"可以拆了"(解禁)

#### 9.2 填入哪几个子段

按 `@gantry/templates/DESIGN.md` § 9 的五个子段(抽象 / 决策 / 契约 / 依赖 / 禁动清单)填写。不适用的子段不写也可(留一句"N/A")。

#### 9.3 严禁事项

- **不要拿"难谁都会用"充入**。表里填的每条都会被 `A-evolve` 用户 review,凑数会被拒。
- **不要重复 0.5.3 "沿用 vs 引入" 段**。§ 9 只记本 change"写出来了什么后续可复用的",不记"本 change 选了什么抽象"。
- 本段不造成 4-dev / 3-task 的压力,他们不读这段。

## 输出

- `.gantry/specs/<change-id>/DESIGN.md`(含 ## ADR 段)
- 仅 PROPOSAL uiImpact=true 时额外输出:`.gantry/specs/<change-id>/UI-DESIGN.md`(结构与旧 2a-ui-design 阶段一致 · 使用 `@gantry/templates/UI-DESIGN.md` 模板 · 含 frontmatter 形式的 design tokens、调性声明、5 维决策、组件规约、Do's and Don'ts)

## 约束

- **R3.1**:禁止给具体代码实现(伪代码可,函数签名可,完整函数体不可)
- 每条决策必须给理由 + 取舍,单纯陈述决策视为不合格
- 不允许"使用最佳实践"这类无意义短语,必须具体
- **§ 8 UI 相关约束**:见 § 8.10(R3.1 延伸 / R8.3 – R8.9)

## 自检

- [ ] 技术栈已锁定(`## 0` 段填齐)
- [ ] **既有架构对齐已写入**(brownfield 必跑 · `## 0.5` 段含触碰模块清单 + 沿用 vs 引新决策 + 禁动清单)
- [ ] 每条决策都有「备选 + 理由 + 代价」
- [ ] 至少一张数据流 / 架构图
- [ ] **§2.1 路径服务序列**:SPEC 每条 Journey 都有跨服务时序(含各环契约/超时/补偿),或 SPEC 声明无跨服务路径时写「无」
- [ ] 风险 ≥ 3 条且每条有缓解
- [ ] 大的或可逆性低的决策都有对应 ADR
- [ ] 不含完整代码实现
- [ ] **§ 8 前端 UI 设计**:PROPOSAL uiImpact=true 时按 § 8.11 UI 自检逐条通过并产出 UI-DESIGN.md;false 时本段明确写「本次 change 无 UI 影响,跳过 § 8」
- [ ] **§ 9 架构沉淀建议已写**(有复用价值就填表,没有就整段写"本 change 无架构层面沉淀建议",禁凑数)

## Post-hook(可选)

完成本阶段所有工作、自检通过后,运行:
```bash
gantry hook run after:design
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 自主模式自检（autonomous=true）

本阶段末尾禁止向用户反问「是否继续 / 要不要先扫一眼 / 是否推进下一阶段」。按 R2.6：
- 产物齐备、门禁通过 → 直接按「触发下一步」执行
- 多选场景 → 取推荐项（无推荐则取列表第一项），把选择与理由写进本阶段产物
- 停止条件按 当前工具的 `gantry-next` 入口「门禁修复循环」：人工确认/所缺用户决策或凭据、宿主剩余预算耗尽、取消/时限、进程/控制记录/用户内容保护；可恢复门禁先在本次调用内诊断修复

## 触发下一步

- → `phases/3-task.md`(不再按 UI / 后端分叉;§ 8 是否展开由 PROPOSAL uiImpact 字段决定,pipeline 层面统一到 task 阶段)


## 研究覆盖台账（复杂变更按需启用）

跨模块契约、外部 API/版本或体验标准尚不明确时，在 PROPOSAL.md 启用
`<!-- gantry:research-ledger -->` 与 `## Research Coverage` 表；简单改动无需创建。
七类 surface 固定为 `contracts`、`lifecycle`、`failure/retry`、`permission/ownership`、
`source-of-truth`、`experience`、`external-version`，每类一行。

表列固定为 `surface | status | evidence | openDecision`，可选 `scope` 列限定任务 ID
或代码路径前缀（逗号分隔，空或 `*` 表示全局）。状态使用：

- `resolved-by-evidence`：已读源码/官方文档，引用仓库相对路径（可带行号）或来源 URL；已解决事实不再询问用户。
- `open-needs-user`：仅记录证据无法确定的业务意图/权衡，必须写明具体 openDecision，再提问。
- `n/a-derived`：evidence 填一行不适用的原因，不能只填 N/A。
- `resolved-by-user`：evidence 以 `user:` 记录用户确认原话或决策来源。
- `default-accepted`：evidence 以 `decision:` 记录已接受的默认值及依据；沉默不能代替必需的授权。

非 open 状态的 openDecision 填 `—`。外部版本事实必须附官方 URL、`version: <版本>`、
`deprecated: no|yes|YYYY-MM-DD`；弃用事实须在设计决定中说明替代路径。
事实写在 evidence 指向的来源，决策写进 SPEC/DESIGN，避免重复大段事实。
若 DESIGN 接替 PROPOSAL 台账，复制七类完整表后更新已解决项，保留原始问题来源；
不能删行、删问题或删除已启用台账来伪装解决。
推进门禁会校验台账完整性和未决项。DEV/TEST 仅加载与任务 scope 匹配的行，
已有来源覆盖的事实直接复用；相关代码/版本变化时先重验再引用，不把历史研究当现状。

## 可选原型

当下一步需要可观察的交互或状态模型来解决一个未决问题时，读取 `.gantry/core/phases/2-prototype.md`，按 `templates/PROTOTYPE.md` 记录 Question / Artifact / Run / Verdict / Decision。它是横向探索协议，不新增阶段。结论回写设计；原型不能替代正式任务、TEST 或 AC 证据。
