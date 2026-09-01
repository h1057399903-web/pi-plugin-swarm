# pi-plugin-swarm

[English](README.md) | 简体中文

一个独立、MIT 授权的 Pi 扩展，用于由主模型协调的并行工作。它通过进程内 Pi `AgentSession` 运行固定为 `openai-codex/gpt-5.6-luna`、thinking `medium` 的 worker，支持最高 16 路并发、稳定 Agent ID、后续恢复和可选的父会话上下文 fork。

## 安装

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

然后重新启动 Pi，或运行 `/reload`。

## 更新

单独更新本扩展：

```bash
pi update git:github.com/h1057399903-web/pi-plugin-swarm
```

或者更新所有已安装的 Pi 扩展包：

```bash
pi update --extensions
```

更新后重新启动 Pi，或运行 `/reload`。通过 Git 安装的扩展目前不会自动升级或弹出新版本通知；执行更新命令时会拉取本仓库 `main` 的最新内容。

## 要求与使用提醒

- 需要 Node.js 22.19 或更新版本及 Pi 0.84.4；本包不承诺兼容其他 Pi SDK 版本。
- Worker 固定使用 `openai-codex/gpt-5.6-luna` 和 `medium` thinking。你的常规 Pi credential store 必须有权访问该模型；本扩展不包含也不管理凭证。
- 委派给 worker 的 `cwd` 必须解析在父 Pi 工作目录内；相对路径、绝对路径和符号链接越界会在 worker 启动前被拒绝。这只是工作目录边界，不是文件系统沙箱：worker 工具仍以相同操作系统账户运行，并可能接受绝对路径。
- 请只在可信工作区安装和运行，并在接受结果前审查 worker 的修改。
- `npm run check` 只执行离线单元测试和打包测试，不会调用模型；`npm run test:live` 是显式的联网验收聚合脚本，会真实调用模型并消耗 Provider 配额。

不需要发布 npm 包或创建 GitHub Release。直接从本仓库安装是受支持的分发方式。

## 命令

```text
/swarm on
/swarm off
/swarm status
/swarm cancel <run-id>
/swarm <任务>
```

主模型可以调用 `swarm` 工具，提交 1–128 个边界清楚的工作包。默认并发会自适应为 `min(worker 总数, 16)`；调用方也可以指定不超过 16 的更低或明确并发值。每个 worker 固定使用 Luna（`openai-codex/gpt-5.6-luna`）和 `medium` thinking。Profile 是运行时强制权限：`explore` 只有 `read`，`coder` 才有 `read`、`bash`、`edit` 和 `write`；为保持兼容，默认是 `coder`。完成的 worker 会返回稳定且按 owner 隔离的 `agentId`，可通过 `resume_agent_ids` 继续；恢复会保留该身份，不会静默替换成新 worker。只有当每个新 worker 都确实需要完整父会话上下文时，才应设置 `fork: true`；resume 与 fork 不能同时使用。仓库调查和只读分析可设置 `subagent_type: "explore"`；实现和验证可设置 `subagent_type: "coder"`。它们使用相同模型，但工具权限由运行时硬性区分；已有 `explore` Session 恢复时不能升级成 `coder`。

## 任务校验与生命周期

- 新任务会先根据任务 prompt（或 `prompt_template`/`promptTemplate` 与 `{{item}}`）渲染，再启动 worker。渲染后的新任务 prompt 重复时，会在创建 Session 前拒绝；恢复项有意不参与此检查。
- `resume_agent_ids` 将已有 `agentId` 映射到后续 prompt，并优先启动这些 worker。恢复要求父 Session 已持久化；`--no-session` 的 worker 位于内存中，不能 resume 或 fork。
- 遇到 rate limit 的重试在等待指数退避时会以临时 `suspended` telemetry 呈现；重试预算耗尽后终态为 `rate_limited`。进度会包含尝试次数以及活动容量的收缩/恢复。公共 integration snapshot/event 只暴露受限的状态、身份、时间、模型/profile 元数据和 usage，不暴露 transcript、路径或凭证值。
- Worker 不得启动或委派其他 worker；本扩展不支持嵌套 swarm。
- 对仍可恢复但未完成的 worker，协调器会收到 `resume_agent_ids: {"<agentId>": "..."}` 形式的 resume hint。

## 运行时模型

调度行为参考 Kimi Code 公开的 MIT Swarm scheduler：

- 最多排队 128 个任务；
- 首批最多启动 5 个 worker；
- 后续 worker 以 700ms 间隔错峰启动；
- Provider rate limit 会触发指数退避并重新排队；
- 遇到限流时自动收缩活动容量，之后逐步恢复；
- 取消 batch 时会向所有运行中的 worker 传播 abort，并等待它们清理完成；
- 保持稳定的任务和结果顺序；
- 合并 token 进度和汇总 UI 更新，避免淹没 TUI。

与 v0.1 不同，worker 不再启动完整的 Pi CLI 子进程，而是在宿主进程中使用官方 Pi SDK：

- 所有 worker 共享一个 `ModelRuntime`；
- 每个 worker 使用独立的 SessionManager；
- 当父 Session 持久化时，worker JSONL 存放在 Pi 专用 `swarm/sessions` 目录下按 owner 隔离的目录中；
- `--no-session` 父会话使用内存 worker；
- 每轮完成后 dispose，恢复时重新加载，以控制内存；
- 不递归加载扩展；
- Profile 绑定工具：`explore` 只有 `read`；`coder` 有 `read`、`bash`、`edit` 和 `write`；
- 公共输出和 usage metadata 均有边界限制。

## 真实验收

v0.4 使用 16 个真实 Luna worker 完成验收。16 个 worker 全部实际调用工具并返回精确结果；峰值并发为 16，墙钟时间 23.56 秒。另一轮 16-worker abort 测试只在全部 16 个 worker 清理完成后返回，耗时 8.59 秒。持久化 resume 也保留了同一 Agent ID，并准确回忆上一轮的值。

这些是可选的联网验收测试，不属于离线单元测试套件。

## Workbench 集成

本包导出 `pi-plugin-swarm/core`，提供进程级 singleton 事件与控制 API。其他 Pi 包可以订阅安全的 run/worker snapshot、取消活动 run 和渲染进度，而无需读取 worker transcript、凭证、错误文本、绝对工作目录或 Session 文件路径。独立 Swarm 包是 `/swarm` 命令和 `swarm` 工具的唯一注册者。Workbench 等宿主只消费公共 API，不能重复注册 Swarm 命令。

## 安全

不要把凭证、生产环境变更、部署、服务重启、设备安装或 merge 委派给 worker。并行 worker 应拥有互不重叠的文件范围。主模型仍负责审查 diff 并执行最终验收。

详见 [SECURITY.md](SECURITY.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
