export type WorkerFailureKind =
  | "rate_limited"
  | "quota_exhausted"
  | "model_unavailable"
  | "auth_failed"
  | "provider_transient"
  | "context_incompatible"
  | "task_failed"
  | "aborted";

export interface WorkerFailureClassification {
  kind: WorkerFailureKind;
  /** Bounded, provider-agnostic text safe to expose to the coordinator. */
  safeMessage: string;
}

const SAFE_TASK_MESSAGES = new Set([
  "Worker failed.",
  "Worker timed out.",
  "Worker session is unavailable.",
  "Worker session is busy.",
  "Worker cwd is outside the parent working directory.",
  "Worker profile mismatch.",
]);

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error === "string" ? error.toLowerCase() : "";
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return [candidate.name, candidate.code, candidate.message]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLowerCase();
}

/**
 * Classify only enough provider/runtime failure semantics for Swarm coordination.
 * Raw provider text is deliberately never returned.
 */
export function classifyWorkerFailure(error: unknown): WorkerFailureClassification {
  const status = statusOf(error);
  const text = errorText(error);
  const message = error instanceof Error ? error.message : undefined;

  if (
    (error instanceof Error && error.name === "AbortError") ||
    /\b(?:aborterror|aborted|cancelled|canceled)\b/.test(text)
  ) {
    return { kind: "aborted", safeMessage: "Aborted." };
  }

  // The Swarm hard timeout is task-level: a slow worker must not poison a model's health.
  if (message === "Worker timed out.") {
    return { kind: "task_failed", safeMessage: "Worker timed out." };
  }

  if (
    /context[_ -]?length|context window|maximum context|max(?:imum)? input|too many input tokens|request too large|prompt too long/.test(text)
  ) {
    return { kind: "context_incompatible", safeMessage: "Worker context is incompatible." };
  }

  if (
    status === 402 ||
    /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|usage limit|monthly limit|free usage limit|out of (?:budget|credits?)|credit balance|available balance|billing limit/.test(text)
  ) {
    return { kind: "quota_exhausted", safeMessage: "Model quota exhausted." };
  }

  if (
    message === "Worker model is unavailable." ||
    status === 404 ||
    /model[_ -]?not[_ -]?found|not_found_error|model (?:is )?not available|model unavailable|no such model|unsupported model|model does not exist/.test(text)
  ) {
    return { kind: "model_unavailable", safeMessage: "Worker model is unavailable." };
  }

  if (
    status === 401 || status === 403 ||
    /invalid[_ -]?(?:api[_ -]?)?key|authentication[_ -]?error|unauthori[sz]ed|forbidden|permission denied|access denied|invalid auth/.test(text)
  ) {
    return { kind: "auth_failed", safeMessage: "Model authentication unavailable." };
  }

  if (
    status === 429 ||
    /rate[_ -]?limit|too many requests|api provider rate limit error/.test(text)
  ) {
    return { kind: "rate_limited", safeMessage: "Provider rate limit." };
  }

  if (
    status === 408 || status === 425 || (status !== undefined && status >= 500 && status <= 599) ||
    /overloaded|service unavailable|server error|internal error|network error|connection (?:error|refused|lost|reset)|econnreset|econnrefused|etimedout|eai_again|fetch failed|socket hang up|upstream|stream ended|provider timeout|request timeout/.test(text)
  ) {
    return { kind: "provider_transient", safeMessage: "Provider temporarily unavailable." };
  }

  if (message && SAFE_TASK_MESSAGES.has(message)) {
    return { kind: "task_failed", safeMessage: message };
  }

  return { kind: "task_failed", safeMessage: "Worker failed." };
}
