export type PublicWorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted" | "rate_limited" | "suspended";

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
}

export interface PublicSwarmRun {
  runId: string;
  description: string;
  status: "running" | "completed" | "failed" | "aborted";
  createdAt: number;
  finishedAt?: number;
  requestedConcurrency: number;
  activeCapacity: number;
  workers: PublicSwarmWorker[];
}

export interface PublicSwarmSnapshot {
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

type GlobalWithSwarm = typeof globalThis & { [KEY]?: SwarmIntegration };

function cloneProfile(profile: PublicSwarmProfile | undefined): PublicSwarmProfile | undefined {
  return profile === "explore" || profile === "coder" ? profile : undefined;
}

function cloneWorker(worker: PublicSwarmWorker): PublicSwarmWorker {
  // Copy the allow-listed public shape. In particular, do not spread runtime
  // objects: callers may attach cwd/session paths to the internal value.
  return {
    workerId: worker.workerId,
    agentId: worker.agentId,
    resumed: worker.resumed,
    resumable: worker.resumable,
    index: worker.index,
    item: worker.item,
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
    model: worker.model,
    thinking: worker.thinking,
    ...(cloneProfile(worker.profile) === undefined ? {} : { profile: cloneProfile(worker.profile) }),
  };
}
function cloneRun(run: PublicSwarmRun): PublicSwarmRun {
  return {
    runId: run.runId,
    description: run.description,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    requestedConcurrency: run.requestedConcurrency,
    activeCapacity: run.activeCapacity,
    workers: run.workers.map(cloneWorker),
  };
}

class Integration implements SwarmIntegration {
  private enabled = false;
  private readonly runs = new Map<string, PublicSwarmRun>();
  private readonly controllers = new Map<string, () => void>();
  private readonly listeners = new Set<(event: PublicSwarmEvent) => void>();

  snapshot(): PublicSwarmSnapshot {
    return {
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
      const evicted = this.runs.keys().next().value!;
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
