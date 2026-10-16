# gantry hooks · 阶段钩子

> 在 gantry 的阶段推进点上挂命令、脚本或 HTTP 通知。
> 场景:变更开始前装依赖、进 dev 前跑 lint、集成完成后通知部署。

---

## 事件表

| 事件 | 触发点 | 失败行为 |
|---|---|---|
| `before:change` | `gantry change` 通过前置检查后、写入 STATE 前 | exit 2,变更不创建 |
| `before:dev` | `gantry advance` / `auto` 门禁已过、转 dev 前 | exit 2,阶段不转 |

事件命名严格 `before:<stage>` / `after:<stage>`。当前仅这两个上线。

---

## 配置

写到 `.gantry/planning/config.json` 的 `hooks` 字段:

```json
{
  "hooks": {
    "before:change": "./scripts/install-tools.sh",
    "before:dev": {
      "type": "script",
      "cmd": "./scripts/pre-dev-check.mjs"
    }
  }
}
```

字符串是简写(自动推断类型),对象允许显式指定 `type`。

---

## 三种类型(自动推断)

| 类型 | 推断规则 | 执行 |
|---|---|---|
| `script` | 以 `./` `/` 开头,或后缀 `.mjs` / `.js` | `import()`,调用 `default({ projectRoot, event })` |
| `http` | 匹配 `https?://` | `fetch(POST)`,body = `{ event, projectRoot }` |
| `shell` | 其余 | `execSync(cmd, { cwd: projectRoot, stdio: 'inherit' })` |

`script` 类型示例:

```javascript
// scripts/pre-dev-check.mjs
export default async function({ projectRoot, event }) {
  // 抛异常 → hook 失败 → gantry exit 2
  const { execSync } = await import('node:child_process');
  execSync('npm run lint', { cwd: projectRoot, stdio: 'inherit' });
}
```

---

## 查看

```bash
gantry hook list
# 输出示例:
#   ✓ before:change          → ./scripts/install-tools.sh (script)
#   ⚠ before:dev             → npm run lint (shell,运行时校验)
#   ✗ after:integration      → ./missing.mjs (脚本不存在: /path/missing.mjs)
```

标记含义:

- `✓` 离线校验通过(脚本文件存在)
- `⚠` 无法离线校验(shell / http),运行时才知道
- `✗` 配置有问题,当前 hook 不会通过 — `gantry hook list` 以 exit 1 提示

---

## 与 Agent 层 hook 的关系

Agent 平台(Claude Code / Codex)自己有一套 hook,比如 Claude Code 的
`SessionStart` / `UserPromptSubmit` / `PreToolUse`。**优先用 Agent 层**,原因:

- 会话粒度:session-start 类的"每次会话拉最新代码 / 更新依赖"是 Agent 生命周期,不是 gantry 阶段生命周期。
- 稳定性:Agent 层由 IDE 主进程管,gantry CLI 只在被显式调用时才运行。用户在 IDE 里点了"新建会话",gantry 不会自动感知。
- 隔离性:Agent hook 失败只影响 IDE 会话,gantry hook 失败会阻断变更推进(设计如此)。

**分工原则:**

| 用什么 | 用哪层 |
|---|---|
| 每次会话开始拉最新组件 / 更新依赖 | Claude Code `SessionStart` |
| 用户提交 prompt 前的 prompt 检查 | Claude Code `UserPromptSubmit` |
| 变更开始前装工具链、校验环境 | gantry `before:change` |
| 进 dev 前跑 lint / 类型检查 | gantry `before:dev` |
| CLI 单独调用(比如 CI 里跑 `gantry change`)的相同需求 | gantry hook 作 fallback |

同一件事只挂一层。挂 Agent 层就别再挂 gantry;需要 CLI 直调场景兜底时,再补 gantry hook。

---

## Claude Code SessionStart 示例(推荐)

在 `~/.claude/settings.json` 或项目 `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "cd $CLAUDE_PROJECT_DIR && git pull --ff-only && npm install" }
        ]
      }
    ]
  }
}
```

这条比 gantry hook 更合适 — 每次开会话都跑,不依赖用户是否显式调用 gantry。

---

## 相关文件

- `src/lib/hooks.mjs` — 执行器 + 离线校验器(`runHook` / `checkHook` / `listHooks`)
- `src/cli.mjs` — `before:change` / `before:dev` 触发点、`gantry hook list` 输出
- `.gantry/planning/config.json` — 用户配置入口
