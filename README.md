# pi-plugin-swarm

English | [简体中文](README.zh-CN.md)

A standalone, MIT-licensed Pi extension for coordinator-driven parallel work. It uses in-process Pi `AgentSession` workers fixed to `openai-codex/gpt-5.6-luna` with `medium` thinking, including 16-way concurrency, stable agent IDs, follow-up resume, and optional parent-context fork.

## Install

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

Then restart Pi or run `/reload`.

## Requirements and usage notes

- Node.js 22.19 or newer is required. The current release is tested with Pi 0.84.4.
- Workers are fixed to `openai-codex/gpt-5.6-luna` with `medium` thinking. Your normal Pi credential store must have access to that model; this package does not include or manage credentials.
- Parallel model calls consume provider quota. A 16-worker run can use substantially more tokens and requests than a single-agent task, so delegate only work that benefits from independent lanes.
- Workers run under the same operating-system account and workspace permissions as the parent Pi. Install and run the package only in trusted workspaces, and review worker changes before accepting them.
- `npm run check` uses offline unit and packaging tests and does not call a model. The `test:live:*` scripts make real networked model calls and may consume quota.

No npm publication or GitHub Release is required. Installing directly from this repository is the supported distribution path.

## Commands

```text
/swarm on
/swarm off
/swarm status
/swarm cancel <run-id>
/swarm <task>
```

The model can call the `swarm` tool with 1–128 bounded work packages. Default concurrency is adaptive (`min(total workers, 16)`); callers may request a lower or explicit limit up to 16. Completed workers return stable `agentId` values and can be resumed with `resume_agent_ids`. New workers can set `fork: true` when every task genuinely requires the completed parent conversation.

## Runtime model

Inspired by Kimi Code's public MIT-licensed swarm scheduler:

- up to 128 queued tasks;
- initial burst of up to 5 workers;
- later workers start at 700 ms intervals;
- provider rate limits requeue with exponential backoff;
- active capacity shrinks on rate limits and recovers gradually;
- batch cancellation propagates to running workers and waits for their cleanup;
- stable task/result ordering;
- token progress and aggregate UI updates are coalesced to avoid TUI flooding.

Unlike v0.1, workers do not start complete Pi CLI child processes. They use the official Pi SDK in the host process with:

- one shared `ModelRuntime`;
- one isolated SessionManager per worker;
- owner-scoped worker JSONL under Pi's dedicated `swarm/sessions` directory when the parent session is persisted;
- in-memory workers for `--no-session` parents;
- dispose-after-run and reload-on-resume to keep memory bounded;
- no extension recursion;
- `read`, `bash`, `edit`, and `write` coding tools;
- bounded public output and usage accounting.

## Live acceptance

The v0.3 acceptance run used 16 real Luna workers. All 16 executed a tool and completed with exact outputs; measured peak concurrency was 16, wall time was 23.93 seconds, and the isolated test process peaked at about 196 MiB RSS. A separate 16-worker abort run returned only after all 16 sessions were disposed (8.51 seconds, about 205 MiB peak RSS). Cross-process tool resume and parent-context fork were also verified with exact model replies.

These are optional networked acceptance tests rather than part of the offline unit suite.

## Workbench integration

The package exports `pi-plugin-swarm/core`, a process-level singleton event/control API. Other Pi packages can subscribe to safe run/worker snapshots, cancel an active run, and render progress without reading worker transcripts, credentials, errors, absolute working directories, or session file paths. The standalone package is the sole owner of `/swarm` and the `swarm` tool. Hosts such as Workbench consume only the public event/control API and never register Swarm commands themselves.

## Safety

Do not delegate credentials, production mutations, deployments, service restarts, device installation, or merges. Parallel workers should own non-overlapping files. The coordinator remains responsible for reviewing diffs and running final verification.

See [SECURITY.md](SECURITY.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
