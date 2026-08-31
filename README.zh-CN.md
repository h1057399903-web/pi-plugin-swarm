# pi-plugin-swarm

[English](README.md) | 简体中文

一个独立、MIT 授权的 Pi 扩展，用于由主模型协调的并行工作。它通过进程内 Pi `AgentSession` 运行固定为 `openai-codex/gpt-5.6-luna`、thinking `medium` 的 worker，支持最高 16 路并发、稳定 Agent ID、后续恢复和可选的父会话上下文 fork。

## 安装

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

然后重新启动 Pi，或运行 `/reload`。

## 要求与使用提醒

- 需要 Node.js 22.19 或更新版本。当前版本已在 Pi 0.84.4 上测试。
- Worker 固定使用 `openai-codex/gpt-5.6-luna` 和 `medium` thinking。你的常规 Pi credential store 必须有权访问该模型；本扩展不包含也不管理凭证。
- 并行模型调用会消耗 Provider 配额。16-worker 运行可能比单 Agent 任务使用更多 token 和请求，因此只应委派真正适合独立执行的工作。
- Worker 与父 Pi 使用相同的操作系统账户和工作区权限。请只在可信工作区安装和运行，并在接受结果前审查 worker 的修改。
- `npm run check` 只执行离线单元测试和打包测试，不会调用模型；`test:live:*` 脚本会真实联网调用模型并可能消耗配额。

不需要发布 npm 包或创建 GitHub Release。直接从本仓库安装是受支持的分发方式。

## 命令

```text
/swarm on
/swarm off
/swarm status
/swarm cancel <run-id>
/swarm <任务>
```

主模型可以调用 `swarm` 工具，提交 1–128 个边界清楚的工作包。默认并发会自适应为 `min(worker 总数, 16)`；调用方也可以指定不超过 16 的更低或明确并发值。已完成的 worker 会返回稳定的 `agentId`，可以通过 `resume_agent_ids` 继续工作。只有当每个新 worker 都确实需要完整父会话上下文时，才应设置 `fork: true`。

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
- 只提供 `read`、`bash`、`edit` 和 `write` 编码工具；
- 公共输出和 usage accounting 均有边界限制。

## 真实验收

v0.3 使用 16 个真实 Luna worker 完成验收。16 个 worker 全部实际调用工具并返回精确结果；峰值并发为 16，墙钟时间 23.93 秒，隔离测试进程峰值 RSS 约 196 MiB。另一轮 16-worker abort 测试只在全部 16 个 Session 都完成 dispose 后返回，耗时 8.51 秒，峰值 RSS 约 205 MiB。跨进程工具 resume 和父上下文 fork 也通过了精确模型回复验证。

这些是可选的联网验收测试，不属于离线单元测试套件。

## Workbench 集成

本包导出 `pi-plugin-swarm/core`，提供进程级 singleton 事件与控制 API。其他 Pi 包可以订阅安全的 run/worker snapshot、取消活动 run 和渲染进度，而无需读取 worker transcript、凭证、错误文本、绝对工作目录或 Session 文件路径。独立 Swarm 包是 `/swarm` 命令和 `swarm` 工具的唯一注册者。Workbench 等宿主只消费公共 API，不能重复注册 Swarm 命令。

## 安全

不要把凭证、生产环境变更、部署、服务重启、设备安装或 merge 委派给 worker。并行 worker 应拥有互不重叠的文件范围。主模型仍负责审查 diff 并执行最终验收。

详见 [SECURITY.md](SECURITY.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
