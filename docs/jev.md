# gantry Jev 预检 · light 入口的语义红线判定

> 可选功能，默认关闭。开启后，`gantry change --tier light` 会在关键词红线之外，再请 TypeSafe 的 Jev 模型判断一次变更描述是否有语义上的高风险。
> Jev 只能把 light 升为 full，不能降档，也不能撤销关键词的命中。

---

## 开关与外发内容

在 `.gantry/planning/config.json`（或全局 `~/.gantry/config.json`）里设置 `jev.enabled: true`，默认值为 `false`。开启后，gantry 只会把**变更描述**发送到 `api.typesafe.ai`，不发送代码、diff、文件路径、`--scope` / `--accept` / `--verify` 的值。API key 只从环境变量 `TYPESAFE_API_KEY` 读取，不支持写进任何配置文件；开关打开但没有设置 key 时，stderr 会提示一行，本次只按关键词预检。Jev 判为红线时 light 回落 `full@change`；判为非红线、或调用失败（超时 3 秒、HTTP 错误、网络错误、响应格式不对），都照常按关键词结果继续，不重试，也不阻断入口。

```json
{
  "jev": { "enabled": true }
}
```

```bash
export TYPESAFE_API_KEY=<你的 key>
gantry change --tier light --scope src/order.mjs "把订单状态的写入改成先发消息再落库"
```

`jev` 下只接受 `enabled` 一个键。写错键或类型不对（例如 `"jev": { "apiKey": "..." }`、`"enabled": "true"`）时，所有 gantry 命令都会报错退出。

---

## 判定规则

| 情况 | 结果 |
|---|---|
| 未开启，或开启但没有 key | 不发请求，只按关键词 |
| 关键词已命中红线，或前面的预检已回落 full | 不发请求 |
| Jev 判为红线概率 ≥ 0.5 | 回落 `full@change`，`reason: jev-semantic` |
| Jev 判为红线概率 < 0.5 | 照常进入 light |
| 调用失败 | 照常按关键词结果，stderr 提示一行 |

只有 light 入口会调用 Jev。默认的 `gantry change`（full）和 light 出口门 `gantry advance` 都不发网络请求。`gantry change --dry-run --tier light` 走同一条预检链，开启时同样会发一次请求。

每次实际调用 Jev，EXECUTION.md 的 `tier-decision` 段会多一行，例如：

```
jev: p=0.94 category=concurrency model=jev-1.13.0
jev: error timeout
```

---

## 阈值未经独立样本验证

阈值 0.5 只在 30 条自标注样本上测过（Jev 召回 100%、误报 0%）。样本和提问由同一人编写，召回的统计下界约 80%，**未经独立样本验证**。打开 `jev.enabled` 之前，建议先请别人另写 10~20 条标注好的描述（held-out 集）复验，达标线是：有风险样本召回 ≥ 80%，无风险样本误报 ≤ 10%。

对照实验脚本在 gantry 仓库之外。held-out 文件格式为 `{ "cases": [ { "id": "h-01", "label": "risky", "text": "..." } ] }`，`label` 取 `risky` 或 `safe`：

```bash
CASES=heldout-cases.json OUT=results/heldout.json HIDE_TEXT=1 \
TYPESAFE_API_KEY=<你的 key> node redline-eval.mjs
```

`HIDE_TEXT=1` 让终端只输出汇总指标，跑脚本的人看不到样本原文。结果里看 `metrics["jev@0.5"]` 的 `recall` 和 `fpr`。

---

## 模型版本

gantry 固定使用 `jev-1.13.0`，不用 `jev-latest`：alias 背后的模型会在不改代码的情况下变化，而阈值是在 1.13.0 上测出来的。升级模型需要：

1. 用新模型重跑对照实验和 held-out 复验
2. 达标后修改 `src/lib/jev-precheck.mjs` 中的 `JEV_MODEL`，必要时调整 `JEV_THRESHOLD`
3. 问题措辞（`JEV_QUESTIONS`）必须与对照实验脚本保持一致，改措辞同样要重跑实验

固定版本下线后，接口会返回错误，gantry 按失败处理并在 stderr 提示，语义保护失效、退回纯关键词。

---

## 其他说明

- `TYPESAFE_BASE_URL` 可覆盖接口根地址，**仅用于测试**（指向本地 mock 服务）。设置它会把 key 发往该地址。
- Node 18 上首次调用 `fetch` 可能在 stderr 打印一次 ExperimentalWarning，不影响结果。
- 每次调用约 800 个输入 token，按官方定价每次不到 $0.0001；入口最多增加 3 秒，实测 p95 约 1 秒。
