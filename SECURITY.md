# Security

Report vulnerabilities privately to the repository owner. Do not open public issues containing credentials, private endpoints, logs, device identifiers, or private project content.

Workers run in-process under the same operating-system account and workspace permissions as the parent Pi. Each worker has an isolated Pi session, but its coding tools can read and modify files available to that account. Use only in trusted workspaces, assign non-overlapping file ownership, and review worker changes before accepting them. Workers are fixed to `openai-codex/gpt-5.6-luna` with `medium` thinking. Capability profiles are enforced by the runtime: `explore` receives only the `read` tool, while `coder` receives `read`, `bash`, `edit`, and `write`; `coder` is the backward-compatible default. Resuming an `explore` worker cannot silently grant `coder` permissions. Neither profile may spawn or delegate another worker, so swarm nesting is not supported.

For persisted parent sessions, worker JSONL is stored in an owner-scoped directory under Pi's dedicated `swarm/sessions` tree. Resume lookup is restricted to that owner directory, and session paths are never returned through tool details or the public integration API. Ephemeral parents use in-memory worker sessions and cannot resume or fork.

Public integration events expose bounded identity, status, timing, model/profile, and usage metadata. Rate-limit retries appear as transient `suspended` telemetry and finish as `rate_limited` if retries are exhausted. They strip worker output and error text and never expose credential values, absolute working directories, or session file paths. The coordinator-facing tool result may include worker output and an unfinished-worker `resume_agent_ids` hint, so workers are instructed never to read or report credentials or private request data. New rendered prompts are duplicate-checked before sessions are created; this does not deduplicate or alter explicit resumes.

## v0.5 coordination and redaction

The v0.5 progress fields are derived from existing session events: bounded per-worker counters, current tool, current safe target, and last activity. Public updates are coalesced and do not cause extra telemetry or model calls. `report_blocked` is a tiny worker tool, not telemetry: its bounded schema contains only `question` (1–500 characters), and its terminate hint produces a minimal blocked final status. It is used instead of transcript parsing; a resumable worker keeps the same owner-scoped `agentId` on resume.

Only edit/write events enter the run-scoped advisory overlap registry. Targets are canonicalized and bounded to workspace-relative paths (at most 32 per worker). The registry reports overlap but provides no locking, ownership change, reservation, or cancellation, and it makes no claims about bash side effects. It is cleared after the run and is not a persistent coordination store.

The `./core` API reports `apiVersion: 2`; its v2 fields are additive and optional. Redaction allow-lists tools, profiles, counters, timestamps, and workspace-relative paths, rejecting absolute, traversal, malformed, or overlong paths and bounding questions to 500 characters. It does not expose transcripts, private request data, credentials, error text, absolute paths, or session paths.

This remains the default `coder` profile and the existing in-process architecture. There are no channels, feeds, inboxes, task databases, coordination memory, polling, watchers, child worker processes, persistent coordination stores, peer messaging, or filesystem sandbox. The workspace boundary is not a filesystem sandbox: tools run as the parent operating-system account.
