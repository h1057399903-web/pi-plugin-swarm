export type PublicWorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted" | "rate_limited";

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
  output?: string;
  error?: string;
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

function cloneWorker(worker: PublicSwarmWorker): PublicSwarmWorker {
  const { output: _output, error: _error, ...safe } = worker;
  return safe;
}
function cloneRun(run: PublicSwarmRun): PublicSwarmRun { return { ...run, workers: run.workers.map(cloneWorker) }; }

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
      runs: [...this.runs.values()].map(cloneRun),
    };
  }

  subscribe(listener: (event: PublicSwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const event: PublicSwarmEvent = { type: "mode", snapshot: this.snapshot() };
    for (const listener of [...this.listeners]) listener(event);
  }

  updateRun(run: PublicSwarmRun): void {
    this.runs.delete(run.runId);
    this.runs.set(run.runId, cloneRun(run));
    while (this.runs.size > MAX_RETAINED_RUNS) this.runs.delete(this.runs.keys().next().value!);
    const event: PublicSwarmEvent = { type: "run", run: cloneRun(run), snapshot: this.snapshot() };
    for (const listener of [...this.listeners]) listener(event);
  }

  removeRun(runId: string): void {
    if (!this.runs.delete(runId)) return;
    this.controllers.delete(runId);
    const event: PublicSwarmEvent = { type: "run_removed", runId, snapshot: this.snapshot() };
    for (const listener of [...this.listeners]) listener(event);
  }

  clearRuns(): void {
    for (const cancel of this.controllers.values()) cancel();
    this.controllers.clear();
    for (const runId of [...this.runs.keys()]) this.removeRun(runId);
  }

  setRunController(runId: string, cancel: (() => void) | undefined): void {
    if (cancel) this.controllers.set(runId, cancel); else this.controllers.delete(runId);
  }

  cancelRun(runId: string): boolean {
    const cancel = this.controllers.get(runId);
    if (!cancel) return false;
    cancel();
    return true;
  }
}

export function getSwarmIntegration(): SwarmIntegration {
  const root = globalThis as GlobalWithSwarm;
  return root[KEY] ??= new Integration();
}
