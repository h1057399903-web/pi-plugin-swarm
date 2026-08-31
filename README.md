# pi-plugin-swarm

A standalone, MIT-licensed Pi extension for coordinator-driven parallel work. It uses in-process, non-persistent Pi `AgentSession` workers fixed to `openai-codex/gpt-5.6-luna` with `medium` thinking.

## Install

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

Then restart Pi or run `/reload`.

## Commands

```text
/swarm on
/swarm off
/swarm status
/swarm <task>
```

The model can call the `swarm` tool with 1–128 bounded work packages. Default concurrency is 2; callers may request up to 16.

## Runtime model

Inspired by Kimi Code's public MIT-licensed swarm scheduler:

- up to 128 queued tasks;
- initial burst of up to 5 workers;
- later workers start at 700 ms intervals;
- provider rate limits requeue with exponential backoff;
- active capacity shrinks on rate limits and recovers gradually;
- batch cancellation propagates to running workers;
- stable task/result ordering.

Unlike v0.1, workers do not start complete Pi CLI child processes. They use the official Pi SDK in the host process with:

- one shared `ModelRuntime`;
- one isolated `SessionManager.inMemory()` per worker;
- no persisted worker sessions;
- no extension recursion;
- `read`, `bash`, `edit`, and `write` coding tools;
- bounded public output and usage accounting.

## Workbench integration

The package exports `pi-plugin-swarm/core`, a process-level singleton event API. Other Pi packages can subscribe to safe run/worker snapshots without reading worker transcripts, credentials, or session files. Registration is idempotent through `Symbol.for(...)`, so a host and the standalone extension do not register duplicate `/swarm` commands.

## Safety

Do not delegate credentials, production mutations, deployments, service restarts, device installation, or merges. Parallel workers should own non-overlapping files. The coordinator remains responsible for reviewing diffs and running final verification.

See [SECURITY.md](SECURITY.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
