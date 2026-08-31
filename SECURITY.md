# Security

Report vulnerabilities privately to the repository owner. Do not open public issues containing credentials, private endpoints, logs, device identifiers, or private project content.

Workers run in-process under the same operating-system account and workspace permissions as the parent Pi. Each worker has an isolated Pi session, but its coding tools can read and modify files available to that account. Use only in trusted workspaces, assign non-overlapping file ownership, and review worker changes before accepting them.

For persisted parent sessions, worker JSONL is stored in an owner-scoped directory under Pi's dedicated `swarm/sessions` tree. Resume lookup is restricted to that owner directory, and session paths are never returned through tool details or the public integration API. Ephemeral parents use in-memory worker sessions and cannot resume or fork.

Public integration events expose bounded identity, status, timing, model, and usage metadata. They strip worker output and error text and never expose credential values, absolute working directories, or session file paths. The coordinator-facing tool result may include worker output, so workers are instructed never to read or report credentials or private request data.
