# 可选探索 · Prototype

这是 CHANGE / DESIGN 期间按需读取的横向协议，不是新增管线阶段，也不是低风险交付的 light 模式。已有明确方案的任务直接进入现有任务流程。

## 进入条件

仅在用户希望试用 UI 方向、操作状态机、验证业务边界或体验 API 时启用。先将要回答的问题限制为一个可观察问题。事实能通过代码或官方文档确认时，先查资料。

## 执行

1. 根据 `templates/PROTOTYPE.md` 在当前 change 记录 Question、Artifact、Run、Verdict、Decision，多个问题拆为独立原型记录。
2. 代码靠近被探索的模块，文件或目录名含 `prototype`。沿用既有运行时和命令入口；状态默认放内存，不新增基础设施或生产写入。
3. 只实现回答问题必需的交互。UI 可在同路由切换不同结构；逻辑可使用最小终端交互，每次操作输出关键状态。
4. 提供一个 Run 命令，实际运行并记录观察。探索阶段无需补生产测试和抽象，正式吸收时重新执行任务验证。
5. 结束时填入具体 Verdict，选择 Delete、Absorb 或 Continue。Delete 删除一次性 Artifact；Absorb 把胜出设计写回正式任务，由任务拥有 production write_files、done 和 verify，然后移除原型外壳；Continue 保留未决问题并继续探索。

## 交付约束

`PROTOTYPE.md` 或 `prototypes/*.md` 存在时，integration 门禁必须调用 `checkPrototypeGate(specsDir, projectRoot, { validateTask })`，其中 validateTask 核实正式任务当前 receipt。Continue、缺字段、未删除的 Artifact、Absorb 缺少已完成正式任务或当前有效 receipt 均阻塞交付。没有创建原型的 change 完全沿用原流程。

原型的可运行结果、截图或用户试用意见用于选择方案，不用于认定正式 AC 已通过。正式任务不得直接运行原型 shell 当作 verify。保留用户反馈和决定后，删除一次性代码；正式测试与运行证据按照 TEST/INTEGRATION 协议重新取得。
