# Third-Party Notices

## MoonshotAI/kimi-code

The scheduler and tool-contract behavior in `src/features/swarm-batch.ts` and `src/index.ts` is an independent Pi implementation informed by the public MIT-licensed Kimi Code swarm design. Relevant upstream comparison files are:

- `packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts`
- `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.ts`
- `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.md`
- `packages/agent-core-v2/src/session/subagent/subagentService.ts`

**Pinned comparison evidence (immutable):** commit [`f6736d7c0de609d44ed1cb761cfe9f195c4d94fb`](https://github.com/MoonshotAI/kimi-code/commit/f6736d7c0de609d44ed1cb761cfe9f195c4d94fb), including the [`AgentRunBatch`](https://github.com/MoonshotAI/kimi-code/blob/f6736d7c0de609d44ed1cb761cfe9f195c4d94fb/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts), [`AgentSwarm`](https://github.com/MoonshotAI/kimi-code/blob/f6736d7c0de609d44ed1cb761cfe9f195c4d94fb/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.ts), and [`agent-swarm.md`](https://github.com/MoonshotAI/kimi-code/blob/f6736d7c0de609d44ed1cb761cfe9f195c4d94fb/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.md) sources. The SHA was verified against GitHub's public commit API and the raw file contents; it is used only as a parity reference, not as a claim about the original source of every behavior here.

The exact original Kimi commit used when this project was first adapted is not recoverable from this repository's Git history or its recorded metadata. We therefore do **not** guess that SHA; the pin above is the verified comparison commit used for current documentation parity.

Copyright (c) Moonshot AI. Kimi Code is licensed under the MIT License. This project is an independent Pi extension. It is not affiliated with, endorsed by, or branded as Kimi Code.
