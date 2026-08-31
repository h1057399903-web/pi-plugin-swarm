# Pi Plugin Swarm

A private Pi package that adds coordinator-driven, cost-controlled worker swarms to the Pi coding agent.

## Behavior

- `/swarm on`, `/swarm off`, `/swarm status`, and `/swarm <task>`
- `swarm` tool with 1–8 isolated worker processes
- workers are pinned to `openai-codex/gpt-5.6-luna` with `medium` thinking
- default concurrency 2; hard maximum 4
- streaming progress, per-worker token/cost details, and abort propagation
- coordinator guidance prefers one worker and rejects unnecessary duplicate review lanes
- worker prompt forbids recursive delegation and keeps deployment, production writes, device operations, merges, and credential handling with the parent

This reproduces the useful Pi-side workflow of a swarm, but it uses isolated Pi subprocesses rather than Kimi Code's internal swarm service.

## Install

```bash
pi install git:github.com/h1057399903-web/pi-plugin-swarm
```

Because the repository is private, the machine must already have GitHub access. Restart Pi after installation.

## Use

```text
/swarm on
/swarm status
/swarm implement the bounded change; use only necessary workers
/swarm off
```

The parent Pi remains responsible for decomposition, conflict avoidance, diff review, integration, and safety decisions.

## Development

```bash
npm install
npm run check
pi -e ./src/index.ts
```

## Security

The repository contains no credentials and does not read external credential files. Worker processes inherit only the normal Pi runtime environment needed to access the configured model. Do not delegate secrets, production mutation, deployment, service restart, device installation, or merge authority to workers.
