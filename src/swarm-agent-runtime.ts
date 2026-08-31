import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

export const WORKER_MODEL = "openai-codex/gpt-5.6-luna";
export const WORKER_THINKING_LEVEL = "medium" as const;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_PROGRESS_THROTTLE_MS = 250;

export type WorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted" | "rate_limited";
export interface WorkerInput {
  workerId: string; prompt: string; cwd: string; item?: unknown; timeoutMs?: number;
  agentId?: string; ownerSessionId?: string; persist?: boolean; resume?: boolean; forkSessionFile?: string;
}
export interface WorkerProgress { workerId: string; status: WorkerStatus; turns: number; output?: string; }
export interface WorkerUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; }
export interface WorkerResult {
  workerId: string; agentId: string; resumable: boolean; status: WorkerStatus; startedAt?: number; finishedAt: number; durationMs: number;
  turns: number; usage: WorkerUsage; output: string; error?: string;
}

export interface RuntimeSeams {
  runtimeFactory?: () => Promise<any>;
  sessionFactory?: (options: any) => Promise<{ session: any }>;
  sessionManagerFactory?: (cwd: string, sessionDir?: string) => any;
  sessionListFactory?: (sessionDir: string) => Promise<any[]>;
  sessionCreateFactory?: (cwd: string, sessionDir: string, agentId?: string) => any;
  sessionOpenFactory?: (path: string, sessionDir: string, cwd: string) => any;
  sessionForkFactory?: (path: string, cwd: string, sessionDir: string, agentId?: string) => any;
  agentDirFactory?: () => string;
  resourceLoaderFactory?: (cwd: string) => any;
  now?: () => number;
  progressThrottleMs?: number;
}

const SAFETY_POLICY = [
  "You are an in-process swarm worker. Work only on the supplied prompt and report the final answer.",
  "Never load extensions, skills, prompt templates, themes, or project context files.",
  "Never reveal credentials, environment secrets, tokens, or private request data.",
  "Use read, bash, edit, and write only inside the delegated working directory. Never start subagents, deploy, restart services, mutate production, install devices, merge pull requests, or handle credentials.",
].join("\n");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x: any) => x?.type === "text").map((x: any) => x.text || "").join("");
}
function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let out = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(out, "utf8") > MAX_OUTPUT_BYTES) out = out.slice(0, -1);
  return out;
}
function usageOf(message: any): WorkerUsage {
  const u = message?.usage || {};
  return { input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, cost: Number(u.cost?.total) || 0 };
}
function addUsage(a: WorkerUsage, b: WorkerUsage): void {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.cost += b.cost;
}
function isRateLimit(error: unknown): boolean {
  const e: any = error;
  return e?.status === 429 || e?.statusCode === 429 || e?.code === 429 || e?.code === "429" ||
    e?.code === "rate_limit_exceeded" || e?.name === "APIProviderRateLimitError" || e?.name === "RateLimitError";
}
function safeError(error: unknown): string {
  if ((error as any)?.safeMessage) return (error as any).safeMessage;
  if (isRateLimit(error)) return "Provider rate limit.";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Aborted.";
    if (["Worker model is unavailable.", "Worker session is unavailable.", "Worker session is busy.", "Worker timed out."].includes(error.message)) return error.message;
  }
  return "Worker failed.";
}

const SESSION_UNAVAILABLE = "Worker session is unavailable.";
function ownerScope(ownerSessionId: string): string {
  return createHash("sha256").update(ownerSessionId || "anonymous", "utf8").digest("hex").slice(0, 32);
}
function sessionDirectory(agentDir: string, ownerSessionId: string): string {
  return join(agentDir, "swarm", "sessions", ownerScope(ownerSessionId));
}
function isInside(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}
function unavailable(): Error {
  const error = new Error(SESSION_UNAVAILABLE);
  (error as any).safeMessage = SESSION_UNAVAILABLE;
  return error;
}

/** In-process Pi worker pool facade with opt-in owner-scoped persistent sessions. */
export class SwarmAgentRuntime {
  private runtimePromise?: Promise<any>;
  private readonly workers = new Map<string, { controller: AbortController; session?: any; cleaned: boolean }>();
  private readonly activeAgents = new Set<string>();
  private readonly seams: RuntimeSeams;
  constructor(seams: RuntimeSeams = {}) { this.seams = seams; }

  private runtime(): Promise<any> {
    return this.runtimePromise ??= (this.seams.runtimeFactory || (() => ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })))();
  }

  async run(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    const started = this.seams.now?.() ?? Date.now();
    let agentId = input.agentId || input.workerId;
    const resumable = input.persist === true;
    const agentKey = resumable && input.agentId ? `${ownerScope(input.ownerSessionId || "anonymous")}:${input.agentId}` : undefined;
    const state = { controller: new AbortController(), cleaned: false, session: undefined as any };
    this.workers.set(input.workerId, state);
    let turns = 0; let output = "";
    let lastOutputProgressAt = -Infinity;
    const progressThrottleMs = Math.max(0, this.seams.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS);
    const usage: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const report = (status: WorkerStatus, chunk?: string) => { onProgress?.({ workerId: input.workerId, status, turns, output: chunk }); };
    const reportOutput = () => {
      const now = this.seams.now?.() ?? Date.now();
      if (now - lastOutputProgressAt < progressThrottleMs) return;
      lastOutputProgressAt = now;
      onProgress?.({ workerId: input.workerId, status: "running", turns, output: cap(output) });
    };
    report("queued");
    report("starting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = input.timeoutMs && input.timeoutMs > 0 ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; state.controller.abort(new Error("Worker timed out.")); void state.session?.abort?.(); reject(new Error("Worker timed out.")); }, input.timeoutMs);
    }) : undefined;
    try {
      if (agentKey) {
        if (this.activeAgents.has(agentKey)) throw Object.assign(new Error("Worker session is busy."), { safeMessage: "Worker session is busy." });
        this.activeAgents.add(agentKey);
      }
      const runtime = await this.runtime();
      state.controller.signal.throwIfAborted();
      const model = runtime?.getModel?.("openai-codex", "gpt-5.6-luna") ?? runtime?.getModel?.(WORKER_MODEL);
      if (!model) throw new Error("Worker model is unavailable.");
      const loader = this.seams.resourceLoaderFactory?.(input.cwd) ?? new DefaultResourceLoader({
        cwd: input.cwd, agentDir: getAgentDir(), noExtensions: true, noPromptTemplates: true, noThemes: true,
        noSkills: true, noContextFiles: true, appendSystemPrompt: [SAFETY_POLICY],
      });
      await (loader as { reload?: () => Promise<void> }).reload?.();
      let sessionManager: any;
      if (!resumable) {
        sessionManager = this.seams.sessionManagerFactory?.(input.cwd) ?? SessionManager.inMemory(input.cwd);
      } else {
        const ownerDir = sessionDirectory(this.seams.agentDirFactory?.() ?? getAgentDir(), input.ownerSessionId || "anonymous");
        if (input.resume) {
          if (!input.agentId) throw unavailable();
          try {
            const sessions = await (this.seams.sessionListFactory || ((dir) => SessionManager.listAll(dir)))(ownerDir);
            const match = sessions.find((session: any) => session?.id === input.agentId && typeof session.path === "string" && isInside(session.path, ownerDir));
            if (!match) throw unavailable();
            sessionManager = this.seams.sessionOpenFactory?.(match.path, ownerDir, input.cwd) ?? SessionManager.open(match.path, ownerDir, input.cwd);
          } catch (error) {
            if ((error as any)?.safeMessage) throw error;
            throw unavailable();
          }
        } else if (input.forkSessionFile) {
          sessionManager = this.seams.sessionForkFactory?.(input.forkSessionFile, input.cwd, ownerDir, input.agentId) ?? SessionManager.forkFrom(input.forkSessionFile, input.cwd, ownerDir, { id: input.agentId });
        } else {
          sessionManager = this.seams.sessionCreateFactory?.(input.cwd, ownerDir, input.agentId) ?? SessionManager.create(input.cwd, ownerDir, { id: input.agentId });
        }
      }
      if (resumable && !input.agentId) agentId = sessionManager.getSessionId?.() || agentId;
      const created = await (this.seams.sessionFactory || createAgentSession)({
        cwd: input.cwd, modelRuntime: runtime, model, thinkingLevel: WORKER_THINKING_LEVEL,
        sessionManager, resourceLoader: loader, tools: ["read", "bash", "edit", "write"],
      });
      state.session = created.session;
      const unsubscribe = state.session.subscribe?.((event: any) => {
        if (event.type === "turn_start") { turns++; report("running"); }
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent?.delta || ""; if (delta) { output += delta; reportOutput(); }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") { output = textOf(event.message.content) || output; addUsage(usage, usageOf(event.message)); }
      });
      report("running");
      const prompt = input.prompt;
      const aborted = new Promise<never>((_, reject) => state.controller.signal.addEventListener("abort", () => reject(state.controller.signal.reason || new Error("Aborted.")), { once: true }));
      const operation = state.session.prompt(prompt, { signal: state.controller.signal });
      await Promise.race([operation, aborted, ...(timeout ? [timeout] : [])]);
      state.controller.signal.throwIfAborted();
      if (!output) { const messages = state.session.messages || state.session.agent?.state?.messages || []; for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") { output = textOf(messages[i].content); addUsage(usage, usageOf(messages[i])); break; } }
      unsubscribe?.(); report("completed");
      const finished = this.seams.now?.() ?? Date.now();
      return { workerId: input.workerId, agentId, resumable, status: "completed", startedAt: started, finishedAt: finished, durationMs: finished - started, turns, usage, output: cap(output) };
    } catch (error) {
      const aborted = !timedOut && (state.controller.signal.aborted || (error as any)?.name === "AbortError");
      const rate = isRateLimit(error);
      const resultStatus: WorkerStatus = rate ? "rate_limited" : aborted ? "aborted" : "failed";
      report(resultStatus);
      const finished = this.seams.now?.() ?? Date.now();
      return { workerId: input.workerId, agentId, resumable, status: resultStatus, startedAt: started, finishedAt: finished, durationMs: finished - started, turns, usage, output: cap(output), error: timedOut ? "Worker timed out." : safeError(error) };
    } finally {
      if (timer) clearTimeout(timer);
      if (agentKey) this.activeAgents.delete(agentKey);
      await this.cleanup(input.workerId);
    }
  }

  abort(workerId: string): boolean { const worker = this.workers.get(workerId); if (!worker) return false; worker.controller.abort(); void worker.session?.abort?.(); return true; }
  async cleanup(workerId: string): Promise<void> { const worker = this.workers.get(workerId); if (!worker || worker.cleaned) return; worker.cleaned = true; try { worker.session?.dispose?.(); } finally { this.workers.delete(workerId); } }
}

export const createSwarmAgentRuntime = (seams?: RuntimeSeams) => new SwarmAgentRuntime(seams);
export async function runSwarmAgentWorker(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void, seams?: RuntimeSeams): Promise<WorkerResult> { return new SwarmAgentRuntime(seams).run(input, onProgress); }
