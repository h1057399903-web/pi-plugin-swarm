# pi-plugin-swarm

English | [简体中文](README.zh-CN.md)

A standalone, MIT-licensed Pi extension for coordinator-driven parallel work. It uses in-process Pi `AgentSession` workers with a session-selectable model (default `openai-codex/gpt-5.6-luna`) and `medium` thinking, including 16-way concurrency, stable agent IDs, follow-up resume, and optional parent-context fork.

## Install

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

Then restart Pi or run `/reload`.

## Update

Update this package directly:

```bash
pi update git:github.com/h1057399903-web/pi-plugin-swarm
```

Or update all installed Pi packages:

```bash
pi update --extensions
```

Then restart Pi or run `/reload`. Git-installed packages do not currently update themselves or show automatic release notifications; running an update command pulls the latest `main` from this repository.

## Requirements and usage notes

- Node.js 22.19 or newer and Pi 0.84.4 are required; this package does not promise compatibility with other Pi SDK versions.
- Workers default to `openai-codex/gpt-5.6-luna` with `medium` thinking. `/swarm model` can select any model available to the current Pi session; this package does not include or manage credentials, and selecting a model does not grant access to it.
- A delegated worker `cwd` must resolve inside the parent Pi working directory; relative, absolute, and symlinked escapes are rejected before worker startup. This is a working-directory boundary, not a filesystem sandbox: worker tools still run under the same operating-system account and may accept absolute paths.
- Install and run the package only in trusted workspaces, and review worker changes before accepting them.
- `npm run check` uses offline unit and packaging tests and does not call a model. `npm run test:live` is the explicit networked acceptance aggregate; it makes real model calls and consumes provider quota.

No npm publication or GitHub Release is required. Installing directly from this repository is the supported distribution path.

## Commands

```text
/swarm on
/swarm off
/swarm status
/swarm model
/swarm model <provider/model>
/swarm model reset
/swarm cancel <run-id>
/swarm <task>
```

`/swarm model` mirrors Pi's `/model` catalog: it uses the current session's scoped models, or all available models when no model scope is configured. The parent session's current model is listed first, followed by the current Swarm model, then the remaining provider/model entries. An explicit `provider/model` must be in that same catalog; arbitrary model strings are rejected. The choice is branch-aware session state, survives reload/resume through the Pi session log, and is snapshotted when each swarm run starts. `reset` selects the default Luna model when it is available. If a saved choice is no longer available, Swarm warns instead of silently switching to a different model.

The model can call the `swarm` tool with 1–128 bounded work packages. Default concurrency is adaptive (`min(total workers, 16)`); callers may request a lower or explicit limit up to 16. Every worker in a run uses the selected model with `medium` thinking. Profiles are enforced runtime capabilities: `explore` receives only `read`, while `coder` receives `read`, `bash`, `edit`, and `write`; `coder` is the backward-compatible default. Completed workers return a stable owner-scoped `agentId` and can be resumed with `resume_agent_ids`; a resumed worker keeps that identity and cannot be silently replaced by a new worker. New workers can set `fork: true` when every task genuinely requires the completed parent conversation. Resume and fork cannot be combined. Set `subagent_type: "explore"` for repository investigation and read-only analysis, or `subagent_type: "coder"` for implementation and verification. Workers in the same run use the same snapshotted model but different enforced tool permissions; an `explore` session cannot be escalated to `coder` when resumed.

## Task validation and lifecycle

- New tasks are rendered from their task prompt (or `prompt_template`/`promptTemplate` and `{{item}}`) before launch. Duplicate rendered prompts are rejected before any session is created; resume entries are intentionally excluded from this check.
- `resume_agent_ids` maps an existing `agentId` to its follow-up prompt and launches those workers first. Resume requires a persisted parent session; `--no-session` workers are ephemeral and cannot resume or fork.
- A rate-limited retry is reported as transient `suspended` telemetry while it waits for exponential backoff. If its retry budget is exhausted, the terminal status is `rate_limited`; progress includes attempts and reduced/recovered active capacity. Public integration snapshots/events expose only bounded status, identity, timing, model/profile, usage, and safe workspace-relative coordination metadata—not transcripts, absolute paths, or credential values.
- Workers must not spawn or delegate to other workers. This extension has no nested swarm execution.
- The coordinator receives a resume hint for unfinished resumable workers, in the form `resume_agent_ids: {"<agentId>": "..."}`.

## v0.5 lightweight coordination

v0.5 derives bounded progress from the existing Pi session events: per-worker tool-call counters, the current tool, the current safe target, and the last-activity timestamp. Public run/worker updates are coalesced; this adds no model calls. Counters and activity are observations, not a second execution channel.

Edit/write tool events feed a run-scoped advisory overlap registry only. Targets are canonicalized and exposed only as bounded workspace-relative paths (up to 32 files per worker); it reports overlapping writers but does not lock, reserve, cancel, or change file ownership. `bash` side effects are deliberately not claimed by this registry. The registry is cleared with the run and is not a persistent coordination store.

Workers also have the tiny `report_blocked` tool. It accepts only a bounded `question` (at most 500 characters), records a minimal blocked final status, and supplies a terminate hint so the session can stop without a separate coordination request. This is used instead of parsing transcripts and is not part of telemetry. A resumable blocked worker keeps the same owner-scoped `agentId` when resumed.

The existing architecture remains the default `coder` profile and in-process Pi SDK `AgentSession` workers. There are no channels, feeds, inboxes, task databases, coordination memory, polling, watchers, child worker processes, persistent coordination stores, peer messaging, or filesystem sandbox. The workspace-relative boundary is a safety check, not a filesystem sandbox; tools run under the parent operating-system account.

`./core` exposes the process-level public API with `apiVersion: 2`. The v2 fields are additive and optional for callers: safe profile, tool counters, current tool/target, last activity, touched/overlap files, and blocked question. Public snapshots/events redact transcripts, error text, credentials, absolute paths, and session paths.

## Runtime model

Inspired by Kimi Code's public MIT-licensed swarm scheduler:

- up to 128 queued tasks;
- initial burst of up to 5 workers;
- later workers start at 700 ms intervals;
- provider rate limits requeue with exponential backoff;
- active capacity shrinks on rate limits and recovers gradually;
- batch cancellation propagates to running workers and waits for their cleanup;
- stable task/result ordering;
- token progress, event-derived activity, and aggregate UI updates are coalesced to avoid TUI flooding;

Unlike v0.1, workers do not start complete Pi CLI child processes. They use the official Pi SDK in the host process with:

- one shared `ModelRuntime`;
- one isolated SessionManager per worker;
- owner-scoped worker JSONL under Pi's dedicated `swarm/sessions` directory when the parent session is persisted;
- in-memory workers for `--no-session` parents;
- dispose-after-run and reload-on-resume to keep memory bounded;
- no extension recursion;
- profile-bound execution tools: `explore` gets `read`; `coder` gets `read`, `bash`, `edit`, and `write`; both profiles also get the bounded terminal-only `report_blocked` backhaul;
- bounded public output and usage metadata.

## Live acceptance

The v0.5 acceptance commands report wall time, peak concurrency, and event count (and the abort command also reports cleanup/status data). Results are intentionally not invented here: run `npm run test:live` in a trusted workspace to obtain the current provider-backed results. These are optional networked acceptance tests rather than part of the offline unit suite.

## Workbench integration

The package exports `pi-plugin-swarm/core`, a process-level singleton event/control API. Other Pi packages can subscribe to safe run/worker snapshots, cancel an active run, and render progress without reading worker transcripts, credentials, errors, absolute working directories, or session file paths. The standalone package is the sole owner of `/swarm` and the `swarm` tool. Hosts such as Workbench consume only the public event/control API and never register Swarm commands themselves.

## Safety

Do not delegate credentials, production mutations, deployments, service restarts, device installation, or merges. Parallel workers should own non-overlapping files. The coordinator remains responsible for reviewing diffs and running final verification.

See [SECURITY.md](SECURITY.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
