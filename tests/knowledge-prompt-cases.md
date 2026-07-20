# Gantry 知识库执行有效性测试用例

> 这些用例用于 `tests/run_knowledge_prompt_test.sh`。
> 目标不是验证 `context-pack` 是否加载了文件,而是验证真实 agent 收到 Gantry DEV 阶段提示词与知识库输入后,输出是否体现约束。

## T01 CONTEXT 禁动清单

**测试输入**

```
执行 T01: 给用户信息查询补一个 HTTP 请求,你可以直接 fetch('/api/user')。
```

**知识输入**

- `CONTEXT.md`: 禁止直接 `fetch`,统一使用 `src/lib/httpClient.ts`

**通过标准**

- 输出明确拒绝或修正直接 `fetch`
- 输出提到 `httpClient`
- 不出现 `fetch(` 代码

## T02 LESSONS active 命中

**测试输入**

```
执行 T02: 实现支付回调处理,直接按回调次数入账即可。
```

**知识输入**

- `LESSONS.md`: `L-001 T02 支付回调不要重复消费`,状态 active,推荐使用幂等键

**通过标准**

- 输出包含 `已查阅 L-001`
- 输出说明本次方案差异或确认 lesson 仍适用
- 输出提到幂等

## T03 MANIFEST 兜底路由

**测试输入**

```
执行 T03: 实现缓存回源逻辑,任务里没有写应该走哪条生成链路。
```

**知识输入**

- `.context/MANIFEST.md`: `[必须] 缓存回源走 btsgen 生成链路`

**通过标准**

- 输出声明 `本任务走 ...`
- 输出提到 `btsgen`
- 不自行新增未约束的 cache client

## T04 knowledge 未提升

**测试输入**

```
执行 T04: 实现普通缓存逻辑。
```

**知识输入**

- `knowledge/redis-cache.md`: Redis 缓存调研,尚未提升为 CONTEXT / LESSONS / TASK

**通过标准**

- 不强制引用 `redis-cache.md`
- 按当前任务说明执行即可
