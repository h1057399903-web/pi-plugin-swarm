# Private Swarm model pool / 私有 Swarm 模型白名单

This is an optional local-only configuration. Do **not** commit your real file to this repository.

这是可选的本机私有配置。**不要**把包含真实模型 target 的文件提交到本仓库。

## Location / 位置

By default Swarm reads `swarm-models.json` from Pi's agent directory (normally `~/.pi/agent/swarm-models.json`, or the directory selected by `PI_CODING_AGENT_DIR`). `PI_SWARM_MODEL_POOL` may point to another local file. Set `PI_SWARM_MODEL_POOL=off` to force legacy single-model behavior.

Swarm 默认从 Pi agent 目录读取 `swarm-models.json`（通常是 `~/.pi/agent/swarm-models.json`，若设置了 `PI_CODING_AGENT_DIR` 则跟随该目录）。也可以用 `PI_SWARM_MODEL_POOL` 指向另一个本机文件；设为 `off` 可强制恢复旧的单模型模式。

## Minimal example / 最小示例

Use synthetic placeholders here; replace them only in your **local private file**:

下面只使用虚构占位符；真实 target 只填写在你的**本机私有文件**里：

```json
{
  "defaultModel": "durable-coder",
  "models": {
    "free-research": {
      "target": "example-provider/free-model",
      "description": "Free; good for broad read-only research",
      "costClass": "free"
    },
    "durable-coder": {
      "target": "example-provider/durable-model",
      "description": "Durable quota; good for routine coding",
      "costClass": "subscription"
    }
  }
}
```

`costClass` may be `free`, `trial`, `subscription`, `metered`, or `unknown`. A model entry may also be the short string form `"alias": "provider/model"` when no description is needed.

`costClass` 可填 `free`、`trial`、`subscription`、`metered` 或 `unknown`。不需要描述时，也可简写成 `"alias": "provider/model"`。

## Behavior / 行为

- When the file is absent, existing `/swarm model` behavior is unchanged.
- When the file is valid, it becomes the Swarm whitelist. The coordinator sees only aliases, cost classes, and descriptions; it may pass `model: "alias"` for one run, or omit it to use `defaultModel`.
- Non-whitelisted aliases are rejected before workers start.
- A configured target must also exist in the current Pi model catalog; otherwise that alias is reported unavailable without exposing its target.
- An invalid existing pool fails closed until the file is fixed and Pi is reloaded.
- The public run/worker model label is the alias; the local target is used only to start the worker.

- 文件不存在时，原来的 `/swarm model` 行为完全不变。
- 文件有效时，它就是 Swarm 白名单。主模型只看到 alias、费用类别和描述；单次 run 可传 `model: "alias"`，省略则使用 `defaultModel`。
- 非白名单 alias 会在 worker 启动前被拒绝。
- 本机 target 还必须存在于当前 Pi 模型目录；若不可用，只报告 alias 不可用，不向主模型暴露 target。
- 已存在但格式错误的模型池会 fail closed，修好文件并 `/reload` 后才恢复。
- 公共 run/worker 只显示 alias；真实 target 只用于本机启动 worker。

## Deliberate non-goals in this slice / 本阶段刻意不做

No automatic fallback, health probe, benchmark/scoring engine, polling loop, background process, persistent health database, or extra router/model call is introduced here.

本阶段**没有**自动 fallback、健康探针、benchmark/评分引擎、轮询、后台进程、持久健康数据库，也不会为了选模型额外调用一次 router/LLM。
