# Security

Report vulnerabilities privately to the repository owner. Do not open public issues containing credentials, private endpoints, logs, device identifiers, or private project content.

Workers run in-process under the same operating-system account and workspace permissions as the parent Pi. Each worker has an isolated in-memory Pi session but its coding tools can read and modify files available to that account. Use only in trusted workspaces, assign non-overlapping file ownership, and review worker changes before accepting them.

Worker sessions are not persisted. Public integration events expose bounded status, timing, usage, and final summaries; they do not expose credential values or Pi session file paths.
