export type PublicWorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted" | "rate_limited" | "suspended" | "blocked";
export type PublicToolName = "read" | "bash" | "edit" | "write" | "report_blocked";
export type PublicToolCounters = Partial<Record<PublicToolName, number>>;

/** Non-sensitive worker profile exposed by the public API. */
export type PublicSwarmProfile = "explore" | "coder";

export interface PublicSwarmWorker {
  workerId: string;
  /** Stable owner-scoped identity used for follow-up/resume. */
  agentId: string;
  resumed: boolean;
  resumable: boolean;
  index: number;
  item: string;
  status: PublicWorkerStatus;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  model: string;
  thinking: string;
  /** Optional safe worker profile (never a cwd or session identifier). */
  profile?: PublicSwarmProfile;
  /** Optional, bounded progress telemetry. */
  toolCalls?: PublicToolCounters;
  currentTool?: PublicToolName;
  currentTarget?: string;
  lastActivityAt?: number;
  touchedFiles?: string[];
  overlapFiles?: string[];
  question?: string;
}

export interface PublicSwarmRun {
  runId: string;
  description: string;
  status: "running" | "completed" | "failed" | "aborted" | "blocked";
  createdAt: number;
  finishedAt?: number;
  requestedConcurrency: number;
  activeCapacity: number;
  workers: PublicSwarmWorker[];
}

export interface PublicSwarmSnapshot {
  /** Current public DTO shape; retained alongside the v1 global singleton key. */
  apiVersion?: 2;
  enabled: boolean;
  model: string;
  thinking: string;
  /** Safe default worker profile; paths and session identity are absent. */
  profile: PublicSwarmProfile;
  runs: PublicSwarmRun[];
}

export type PublicSwarmEvent =
  | { type: "mode"; snapshot: PublicSwarmSnapshot }
  | { type: "run"; run: PublicSwarmRun; snapshot: PublicSwarmSnapshot }
  | { type: "run_removed"; runId: string; snapshot: PublicSwarmSnapshot };

export interface SwarmIntegration {
  snapshot(): PublicSwarmSnapshot;
  subscribe(listener: (event: PublicSwarmEvent) => void): () => void;
  setEnabled(enabled: boolean): void;
  updateRun(run: PublicSwarmRun): void;
  removeRun(runId: string): void;
  clearRuns(): void;
  setRunController(runId: string, cancel: (() => void) | undefined): void;
  cancelRun(runId: string): boolean;
}

const KEY = Symbol.for("pi-plugin-swarm.integration.v1");
const MAX_RETAINED_RUNS = 20;
const MAX_TOOL_CALL_COUNT = 1_000_000;
const MAX_FILES = 32;
const MAX_PATH_LENGTH = 512;
const MAX_QUESTION_LENGTH = 500;
const MAX_ID_LENGTH = 200;
const MAX_ITEM_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_MODEL_LENGTH = 200;
const MAX_THINKING_LENGTH = 50;
const MAX_WORKERS_PER_RUN = 128;
const SAFE_TOOLS = new Set<PublicToolName>(["read", "bash", "edit", "write", "report_blocked"]);

type GlobalWithSwarm = typeof globalThis & { [KEY]?: SwarmIntegration };

function cloneProfile(profile: PublicSwarmProfile | undefined): PublicSwarmProfile | undefined {
  return profile === "explore" || profile === "coder" ? profile : undefined;
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function safeLabel(value: unknown, maxLength: number): string {
  return boundedText(value, maxLength)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s<>"'`]+/gi, "[url]")
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/gi, "Authorization: [redacted]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[-_ ]?key|token|password|passwd|secret|credential)\b(?:\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/(?:file:\/\/)?\\\\[^\s<>"'`]+/gi, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`]+/g, "[path]")
    .replace(/(^|[\s(])\/(?:[^/\s<>"'`]+\/)*[^/\s<>"'`,;)]+/g, "$1[path]")
    .slice(0, maxLength);
}

function safeQuestion(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return safeLabel(value, MAX_QUESTION_LENGTH);
}

function safeTool(tool: unknown): PublicToolName | undefined {
  return typeof tool === "string" && SAFE_TOOLS.has(tool as PublicToolName) ? tool as PublicToolName : undefined;
}

function safePath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return undefined;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return path;
}

function safePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const path = safePath(candidate);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
      if (paths.length === MAX_FILES) break;
    }
  }
  return paths.length ? paths : undefined;
}

function safeToolCalls(value: unknown): PublicToolCounters | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const counters: PublicToolCounters = {};
  for (const [candidate, count] of Object.entries(value)) {
    const tool = safeTool(candidate);
    if (tool && typeof count === "number" && Number.isInteger(count) && count >= 0) {
      counters[tool] = Math.min(count, MAX_TOOL_CALL_COUNT);
    }
  }
  return Object.keys(counters).length ? counters : undefined;
}

function safeActivityTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cloneWorker(worker: PublicSwarmWorker): PublicSwarmWorker {
  // Copy the allow-listed public shape. In particular, do not spread runtime
  // objects: callers may attach cwd/session paths to the internal value.
  return {
    workerId: boundedText(worker.workerId, MAX_ID_LENGTH),
    agentId: boundedText(worker.agentId, MAX_ID_LENGTH),
    resumed: worker.resumed,
    resumable: worker.resumable,
    index: worker.index,
    item: safeLabel(worker.item, MAX_ITEM_LENGTH),
    status: worker.status,
    attempt: worker.attempt,
    ...(worker.startedAt === undefined ? {} : { startedAt: worker.startedAt }),
    ...(worker.finishedAt === undefined ? {} : { finishedAt: worker.finishedAt }),
    ...(worker.durationMs === undefined ? {} : { durationMs: worker.durationMs }),
    turns: worker.turns,
    inputTokens: worker.inputTokens,
    outputTokens: worker.outputTokens,
    cacheReadTokens: worker.cacheReadTokens,
    cost: worker.cost,
    model: boundedText(worker.model, MAX_MODEL_LENGTH),
    thinking: boundedText(worker.thinking, MAX_THINKING_LENGTH),
    ...(cloneProfile(worker.profile) === undefined ? {} : { profile: cloneProfile(worker.profile) }),
    ...(safeToolCalls(worker.toolCalls) === undefined ? {} : { toolCalls: safeToolCalls(worker.toolCalls) }),
    ...(safeTool(worker.currentTool) === undefined ? {} : { currentTool: safeTool(worker.currentTool) }),
    ...(safePath(worker.currentTarget) === undefined ? {} : { currentTarget: safePath(worker.currentTarget) }),
    ...(safeActivityTime(worker.lastActivityAt) === undefined ? {} : { lastActivityAt: safeActivityTime(worker.lastActivityAt) }),
    ...(safePaths(worker.touchedFiles) === undefined ? {} : { touchedFiles: safePaths(worker.touchedFiles) }),
    ...(safePaths(worker.overlapFiles) === undefined ? {} : { overlapFiles: safePaths(worker.overlapFiles) }),
    ...(safeQuestion(worker.question) === undefined ? {} : { question: safeQuestion(worker.question) }),
  };
}
function cloneRun(run: PublicSwarmRun): PublicSwarmRun {
  return {
    runId: boundedText(run.runId, MAX_ID_LENGTH),
    description: safeLabel(run.description, MAX_DESCRIPTION_LENGTH),
    status: run.status,
    createdAt: run.createdAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    requestedConcurrency: run.requestedConcurrency,
    activeCapacity: run.activeCapacity,
    workers: run.workers.slice(0, MAX_WORKERS_PER_RUN).map(cloneWorker),
  };
}

class Integration implements SwarmIntegration {
  private enabled = false;
  private readonly runs = new Map<string, PublicSwarmRun>();
  private readonly controllers = new Map<string, () => void>();
  private readonly listeners = new Set<(event: PublicSwarmEvent) => void>();

  snapshot(): PublicSwarmSnapshot {
    return {
      apiVersion: 2,
      enabled: this.enabled,
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      profile: "coder",
      runs: [...this.runs.values()].map(cloneRun),
    };
  }

  subscribe(listener: (event: PublicSwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PublicSwarmEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone(event)); } catch { /* Optional observers cannot break or mutate the swarm runtime. */ }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const event: PublicSwarmEvent = { type: "mode", snapshot: this.snapshot() };
    this.emit(event);
  }

  updateRun(run: PublicSwarmRun): void {
    this.runs.delete(run.runId);
    this.runs.set(run.runId, cloneRun(run));
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const evicted = this.runs.keys().next().value;
      if (evicted === undefined) break;
      this.runs.delete(evicted);
      this.controllers.delete(evicted);
    }
    const event: PublicSwarmEvent = { type: "run", run: cloneRun(run), snapshot: this.snapshot() };
    this.emit(event);
  }

  removeRun(runId: string): void {
    if (!this.runs.delete(runId)) return;
    this.controllers.delete(runId);
    const event: PublicSwarmEvent = { type: "run_removed", runId, snapshot: this.snapshot() };
    this.emit(event);
  }

  clearRuns(): void {
    for (const cancel of this.controllers.values()) {
      try { cancel(); } catch { /* A controller is optional and must not break cleanup. */ }
    }
    this.controllers.clear();
    for (const runId of [...this.runs.keys()]) this.removeRun(runId);
  }

  setRunController(runId: string, cancel: (() => void) | undefined): void {
    if (cancel) this.controllers.set(runId, cancel); else this.controllers.delete(runId);
  }

  cancelRun(runId: string): boolean {
    const cancel = this.controllers.get(runId);
    if (!cancel) return false;
    try { cancel(); } catch { /* Optional controllers cannot break the public API. */ }
    return true;
  }
}

export function getSwarmIntegration(): SwarmIntegration {
  const root = globalThis as GlobalWithSwarm;
  return root[KEY] ??= new Integration();
}
