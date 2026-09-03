import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Type } from "typebox";
import { resolveWorkspaceTarget, type ResolvedWorkspaceTarget } from "./lightweight-coordination.ts";
import { classifyWorkerFailure, type WorkerFailureKind } from "./model-failure.ts";

export const WORKER_MODEL = "openai-codex/gpt-5.6-luna";
export const WORKER_THINKING_LEVEL = "medium" as const;
export const MAX_WORKER_MODEL_LENGTH = 200;

export interface WorkerModelReference { provider: string; id: string; value: string; }

export function parseWorkerModel(value: unknown): WorkerModelReference | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WORKER_MODEL_LENGTH || value.trim() !== value || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1), value };
}
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_PROGRESS_THROTTLE_MS = 250;
export const MAX_QUESTION_LENGTH = 500;
const MAX_TOOL_CALL_COUNT = 1_000_000;
const REPORT_BLOCKED_TOOL = "report_blocked" as const;

export type WorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted" | "rate_limited" | "blocked";
export type WorkerToolName = "read" | "bash" | "edit" | "write" | typeof REPORT_BLOCKED_TOOL;
export type WorkerToolCounters = Partial<Record<WorkerToolName, number>>;
export type WorkerProfile = "explore" | "coder";
export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_WORKER_PROFILE: WorkerProfile = "coder";
const WORKER_METADATA_TYPE = "pi-plugin-swarm.worker";
const PROFILE_TOOLS: Record<WorkerProfile, string[]> = {
  explore: ["read"],
  coder: ["read", "bash", "edit", "write"],
};
export interface WorkerProviderRegistration { native?: unknown; config?: unknown; }
export interface WorkerInput {
  workerId: string; prompt: string; cwd: string; parentCwd?: string; item?: unknown; timeoutMs?: number; model?: string; thinkingLevel?: WorkerThinkingLevel;
  /** Host-resolved model/provider data for providers registered dynamically in this Pi process. */
  modelDefinition?: { provider?: unknown; id?: unknown };
  providerRegistration?: WorkerProviderRegistration;
  profile?: WorkerProfile; subagentType?: WorkerProfile; subagent_type?: WorkerProfile; agentId?: string; ownerSessionId?: string; persist?: boolean; resume?: boolean; forkSessionFile?: string;
  /** Internal run-scoped sink. Targets are already canonical and workspace-relative. */
  onWriteTarget?: (target: ResolvedWorkspaceTarget) => void;
}
export interface WorkerProgress {
  workerId: string; status: WorkerStatus; turns: number; output?: string; profile?: WorkerProfile; item?: unknown;
  toolCalls: WorkerToolCounters; currentTool?: WorkerToolName; currentTarget?: string; lastActivityAt?: number; question?: string;
}
export interface WorkerUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; }
export interface WorkerResult {
  workerId: string; agentId: string; resumable: boolean; status: WorkerStatus; startedAt?: number; finishedAt: number; durationMs: number;
  turns: number; usage: WorkerUsage; output: string; profile: WorkerProfile; item?: unknown; error?: string; failureKind?: WorkerFailureKind;
  toolCalls: WorkerToolCounters; currentTool?: WorkerToolName; currentTarget?: string; lastActivityAt?: number; question?: string;
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
  realpathFactory?: (path: string) => Promise<string>;
  now?: () => number;
  progressThrottleMs?: number;
}

const SAFETY_POLICY = [
  "You are an in-process swarm worker. Work only on the supplied prompt and report the final answer.",
  "Never load extensions, skills, prompt templates, themes, or project context files.",
  "Never reveal credentials, environment secrets, tokens, or private request data.",
  "Use only the tools granted by your enforced capability profile and stay inside the delegated working directory. Never start subagents, deploy, restart services, mutate production, install devices, merge pull requests, or handle credentials.",
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
const SESSION_UNAVAILABLE = "Worker session is unavailable.";
const CWD_UNAVAILABLE = "Worker cwd is outside the parent working directory.";
const ACTIVE_AGENTS_KEY = Symbol.for("pi-plugin-swarm.active-agents.v1");
type GlobalWithActiveAgents = typeof globalThis & { [ACTIVE_AGENTS_KEY]?: Set<string> };
function activeAgents(): Set<string> {
  const root = globalThis as GlobalWithActiveAgents;
  return root[ACTIVE_AGENTS_KEY] ??= new Set<string>();
}
function ownerScope(ownerSessionId: string): string {
  return createHash("sha256").update(ownerSessionId || "anonymous", "utf8").digest("hex").slice(0, 32);
}
function sessionDirectory(agentDir: string, ownerSessionId: string): string {
  return join(agentDir, "swarm", "sessions", ownerScope(ownerSessionId));
}
/** Compare canonical paths without depending on the host OS (tests cover both syntaxes). */
export function isPathInside(path: string, directory: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(directory) || path.includes("\\\\") || directory.includes("\\\\");
  const pathApi = windows ? win32 : { relative, resolve };
  const rel = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function unavailable(): Error {
  const error = new Error(SESSION_UNAVAILABLE);
  (error as any).safeMessage = SESSION_UNAVAILABLE;
  return error;
}

/** In-process Pi worker pool facade with opt-in owner-scoped persistent sessions. */
export class SwarmAgentRuntime {
  private runtimePromise?: Promise<any>;
  private readonly workers = new Map<string, { controller: AbortController; session?: any; cleanupPromise?: Promise<void> }>();
  private readonly seams: RuntimeSeams;
  constructor(seams: RuntimeSeams = {}) { this.seams = seams; }

  private runtime(): Promise<any> {
    return this.runtimePromise ??= (this.seams.runtimeFactory || (() => ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })))();
  }

  async run(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    const started = this.seams.now?.() ?? Date.now();
    let agentId = input.agentId || input.workerId;
    const requestedProfile = input.profile || input.subagentType || input.subagent_type;
    let profile: WorkerProfile = requestedProfile === "explore" || requestedProfile === "coder" ? requestedProfile : DEFAULT_WORKER_PROFILE;
    let item = input.item;
    let metadataResolved = input.resume !== true;
    const resumable = input.persist === true;
    let sessionAvailable = false;
    const agentKey = resumable && input.agentId ? `${ownerScope(input.ownerSessionId || "anonymous")}:${input.agentId}` : undefined;
    const state = { controller: new AbortController(), session: undefined as any, cleanupPromise: undefined as Promise<void> | undefined };
    this.workers.set(input.workerId, state);
    let turns = 0; let output = ""; let question: string | undefined;
    let terminal = false;
    let lastOutputProgressAt = -Infinity;
    let lastActivityProgressAt = -Infinity;
    let lastActivityAt: number | undefined;
    let workspaceRoot: string | undefined;
    let canonicalWorkerCwd: string | undefined;
    const toolCalls: WorkerToolCounters = {};
    const activeTools = new Map<string, { toolName: WorkerToolName; target?: string }>();
    const pendingTargets = new Set<Promise<void>>();
    const progressThrottleMs = Math.max(0, this.seams.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS);
    const usage: WorkerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const activity = () => {
      const current = [...activeTools.values()].at(-1);
      return {
        toolCalls: { ...toolCalls },
        ...(current ? { currentTool: current.toolName, ...(current.target ? { currentTarget: current.target } : {}) } : {}),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        ...(question ? { question } : {}),
      };
    };
    const report = (status: WorkerStatus, chunk?: string) => {
      onProgress?.({ workerId: input.workerId, status, turns, output: chunk, ...activity(), ...(metadataResolved ? { profile, item } : {}) });
    };
    const reportOutput = () => {
      const now = this.seams.now?.() ?? Date.now();
      if (now - lastOutputProgressAt < progressThrottleMs) return;
      lastOutputProgressAt = now;
      report("running", cap(output));
    };
    const reportActivity = () => {
      const now = this.seams.now?.() ?? Date.now();
      if (now - lastActivityProgressAt < progressThrottleMs) return;
      lastActivityProgressAt = now;
      report("running");
    };
    const safeToolName = (value: unknown): WorkerToolName | undefined =>
      value === "read" || value === "bash" || value === "edit" || value === "write" || value === REPORT_BLOCKED_TOOL ? value : undefined;
    report("queued");
    report("starting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = input.timeoutMs && input.timeoutMs > 0 ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; state.controller.abort(new Error("Worker timed out.")); void state.session?.abort?.(); reject(new Error("Worker timed out.")); }, input.timeoutMs);
    }) : undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (agentKey) {
        if (activeAgents().has(agentKey)) throw Object.assign(new Error("Worker session is busy."), { safeMessage: "Worker session is busy." });
        activeAgents().add(agentKey);
      }
      const aborted = new Promise<never>((_, reject) => state.controller.signal.addEventListener("abort", () => reject(state.controller.signal.reason || new Error("Aborted.")), { once: true }));
      const operation = (async () => {
        let workerCwd = input.cwd;
        if (requestedProfile && requestedProfile !== "explore" && requestedProfile !== "coder") throw Object.assign(new Error("Worker profile mismatch."), { safeMessage: "Worker profile mismatch." });
        if (input.parentCwd) {
          const canonicalize = this.seams.realpathFactory ?? realpath;
          let canonicalParent: string;
          let canonicalCwd: string;
          try {
            const requestedCwd = isAbsolute(input.cwd) || win32.isAbsolute(input.cwd) ? input.cwd : resolve(input.parentCwd, input.cwd);
            [canonicalParent, canonicalCwd] = await Promise.all([canonicalize(input.parentCwd), canonicalize(requestedCwd)]);
          } catch {
            throw Object.assign(new Error(CWD_UNAVAILABLE), { safeMessage: CWD_UNAVAILABLE });
          }
          if (!isPathInside(canonicalCwd, canonicalParent)) throw Object.assign(new Error(CWD_UNAVAILABLE), { safeMessage: CWD_UNAVAILABLE });
          workerCwd = canonicalCwd;
          workspaceRoot = canonicalParent;
          canonicalWorkerCwd = canonicalCwd;
        }
        state.controller.signal.throwIfAborted();
        const workerModel = parseWorkerModel(input.model ?? WORKER_MODEL);
        if (!workerModel) throw new Error("Worker model is unavailable.");
        const runtime = await this.runtime();
        state.controller.signal.throwIfAborted();
        const registration = input.providerRegistration;
        if (registration?.native && typeof runtime?.registerNativeProvider === "function") {
          runtime.registerNativeProvider(registration.native);
        } else if (registration?.config && typeof runtime?.registerProvider === "function") {
          runtime.registerProvider(workerModel.provider, registration.config);
        }
        const suppliedModel = input.modelDefinition;
        const model = suppliedModel?.provider === workerModel.provider && suppliedModel.id === workerModel.id
          ? suppliedModel
          : runtime?.getModel?.(workerModel.provider, workerModel.id);
        if (!model) throw new Error("Worker model is unavailable.");
        const loader = this.seams.resourceLoaderFactory?.(workerCwd) ?? new DefaultResourceLoader({
          cwd: workerCwd, agentDir: getAgentDir(), noExtensions: true, noPromptTemplates: true, noThemes: true,
          noSkills: true, noContextFiles: true, appendSystemPrompt: [SAFETY_POLICY],
        });
        await (loader as { reload?: () => Promise<void> }).reload?.();
        state.controller.signal.throwIfAborted();
        let sessionManager: any;
        if (!resumable) {
          sessionManager = this.seams.sessionManagerFactory?.(workerCwd) ?? SessionManager.inMemory(workerCwd);
        } else {
          const ownerDir = sessionDirectory(this.seams.agentDirFactory?.() ?? getAgentDir(), input.ownerSessionId || "anonymous");
          if (input.resume) {
            if (!input.agentId) throw unavailable();
            try {
              const sessions = await (this.seams.sessionListFactory || ((dir) => SessionManager.listAll(dir)))(ownerDir);
              state.controller.signal.throwIfAborted();
              const match = sessions.find((session: any) => session?.id === input.agentId && typeof session.path === "string");
              if (!match) throw unavailable();
              const canonicalize = this.seams.realpathFactory ?? realpath;
              const [canonicalOwnerDir, canonicalSessionPath] = await Promise.all([canonicalize(ownerDir), canonicalize(match.path)]);
              if (!isPathInside(canonicalSessionPath, canonicalOwnerDir)) throw unavailable();
              sessionManager = this.seams.sessionOpenFactory?.(canonicalSessionPath, ownerDir, workerCwd) ?? SessionManager.open(canonicalSessionPath, ownerDir, workerCwd);
              const entries = sessionManager.getEntries?.() || match.entries || [];
              const metadata = [...entries].reverse().find((entry: any) => entry?.type === "custom" && entry.customType === WORKER_METADATA_TYPE)?.data;
              const recoveredProfile: WorkerProfile = metadata?.profile === "explore" || metadata?.profile === "coder" ? metadata.profile : DEFAULT_WORKER_PROFILE;
              if (requestedProfile && requestedProfile !== recoveredProfile) throw Object.assign(new Error("Worker profile mismatch."), { safeMessage: "Worker profile mismatch." });
              profile = recoveredProfile;
              if (metadata && Object.prototype.hasOwnProperty.call(metadata, "item")) item = metadata.item;
              metadataResolved = true;
            } catch (error) {
              if (state.controller.signal.aborted) throw state.controller.signal.reason;
              if ((error as any)?.safeMessage) throw error;
              throw unavailable();
            }
          } else if (input.forkSessionFile) {
            sessionManager = this.seams.sessionForkFactory?.(input.forkSessionFile, workerCwd, ownerDir, input.agentId) ?? SessionManager.forkFrom(input.forkSessionFile, workerCwd, ownerDir, { id: input.agentId });
          } else {
            sessionManager = this.seams.sessionCreateFactory?.(workerCwd, ownerDir, input.agentId) ?? SessionManager.create(workerCwd, ownerDir, { id: input.agentId });
          }
        }
        sessionAvailable = resumable;
        state.controller.signal.throwIfAborted();
        if (resumable && !input.agentId) agentId = sessionManager.getSessionId?.() || agentId;
        if (resumable && !input.resume) {
          sessionManager.appendCustomEntry?.(WORKER_METADATA_TYPE, { profile, item: input.item });
        }
        const blockedTool: ToolDefinition = {
          name: REPORT_BLOCKED_TOOL,
          label: "Report blocked",
          description: "Stop this worker and return one bounded question to the coordinator when the task cannot safely continue.",
          parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: MAX_QUESTION_LENGTH }) }),
          execute: async (_toolCallId, params: any) => {
            question = String(params.question).slice(0, MAX_QUESTION_LENGTH);
            lastActivityAt = this.seams.now?.() ?? Date.now();
            reportActivity();
            return { content: [{ type: "text", text: "Blocked question recorded for the coordinator." }], details: undefined, terminate: true };
          },
        };
        const tools = [...PROFILE_TOOLS[profile], REPORT_BLOCKED_TOOL];
        const created = await (this.seams.sessionFactory || createAgentSession)({
          cwd: workerCwd, modelRuntime: runtime, model, thinkingLevel: input.thinkingLevel ?? WORKER_THINKING_LEVEL,
          sessionManager, resourceLoader: loader, tools, customTools: [blockedTool],
        });
        state.session = created.session;
        if (state.controller.signal.aborted) {
          try { await Promise.resolve(state.session?.dispose?.()); } finally { state.session = undefined; }
          state.controller.signal.throwIfAborted();
        }
        const trackTarget = (event: any) => {
          if (!workspaceRoot || !canonicalWorkerCwd || typeof event.args?.path !== "string") return;
          let pending!: Promise<void>;
          pending = resolveWorkspaceTarget({
            workspaceRoot,
            workingDirectory: canonicalWorkerCwd,
            target: event.args.path,
            realpath: this.seams.realpathFactory ?? realpath,
            rootsAreCanonical: true,
          }).then((target) => {
            if (terminal || !target) return;
            const active = activeTools.get(event.toolCallId);
            if (active) active.target = target.relativePath;
            if (event.toolName === "edit" || event.toolName === "write") {
              try { input.onWriteTarget?.(target); } catch { /* Advisory observers never affect tool execution. */ }
            }
          }).catch(() => { /* Unknown or unsafe targets are deliberately omitted. */ })
            .finally(() => {
              pendingTargets.delete(pending);
              if (!terminal) reportActivity();
            });
          pendingTargets.add(pending);
        };
        unsubscribe = state.session.subscribe?.((event: any) => {
          if (terminal) return;
          if (event.type === "turn_start") { turns++; report("running"); }
          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent?.delta || ""; if (delta) { output += delta; reportOutput(); }
          }
          if (event.type === "message_end" && event.message?.role === "assistant") { output = textOf(event.message.content) || output; addUsage(usage, usageOf(event.message)); }
          if (event.type === "tool_execution_start") {
            const toolName = safeToolName(event.toolName);
            if (!toolName || typeof event.toolCallId !== "string") return;
            toolCalls[toolName] = Math.min((toolCalls[toolName] ?? 0) + 1, MAX_TOOL_CALL_COUNT);
            activeTools.set(event.toolCallId, { toolName });
            lastActivityAt = this.seams.now?.() ?? Date.now();
            if (toolName === "read" || toolName === "edit" || toolName === "write") trackTarget(event);
            else reportActivity();
          }
          if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
            activeTools.delete(event.toolCallId);
            lastActivityAt = this.seams.now?.() ?? Date.now();
            reportActivity();
          }
        });
        report("running");
        await state.session.prompt(input.prompt, { signal: state.controller.signal });
        state.controller.signal.throwIfAborted();
        for (const pendingTarget of [...pendingTargets]) await pendingTarget.catch(() => undefined);
      })();
      await Promise.race([operation, aborted, ...(timeout ? [timeout] : [])]);
      if (!output) { const messages = state.session.messages || state.session.agent?.state?.messages || []; for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") { output = textOf(messages[i].content); addUsage(usage, usageOf(messages[i])); break; } }
      const resultStatus: WorkerStatus = question ? "blocked" : "completed";
      terminal = true;
      activeTools.clear();
      report(resultStatus);
      const finished = this.seams.now?.() ?? Date.now();
      return { workerId: input.workerId, agentId, resumable: resumable && sessionAvailable, status: resultStatus, startedAt: started, finishedAt: finished, durationMs: finished - started, turns, usage, output: cap(output), profile, item, ...activity() };
    } catch (error) {
      const classified = timedOut
        ? { kind: "task_failed" as const, safeMessage: "Worker timed out." }
        : classifyWorkerFailure(error);
      const aborted = !timedOut && (state.controller.signal.aborted || classified.kind === "aborted");
      const failureKind: WorkerFailureKind = aborted ? "aborted" : classified.kind;
      const resultStatus: WorkerStatus = failureKind === "rate_limited" ? "rate_limited" : aborted ? "aborted" : "failed";
      const errorMessage = aborted ? "Aborted." : classified.safeMessage;
      terminal = true;
      activeTools.clear();
      report(resultStatus);
      const finished = this.seams.now?.() ?? Date.now();
      return { workerId: input.workerId, agentId, resumable: resumable && sessionAvailable, status: resultStatus, startedAt: started, finishedAt: finished, durationMs: finished - started, turns, usage, output: cap(output), profile, item, error: errorMessage, failureKind, ...activity() };
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      if (agentKey) activeAgents().delete(agentKey);
      await this.cleanup(input.workerId);
    }
  }

  abort(workerId: string): boolean { const worker = this.workers.get(workerId); if (!worker) return false; worker.controller.abort(); void worker.session?.abort?.(); return true; }
  async cleanup(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.cleanupPromise ??= (async () => {
      try { await Promise.resolve(worker.session?.dispose?.()); }
      finally { this.workers.delete(workerId); }
    })();
    await worker.cleanupPromise;
  }
}

export const createSwarmAgentRuntime = (seams?: RuntimeSeams) => new SwarmAgentRuntime(seams);
export async function runSwarmAgentWorker(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void, seams?: RuntimeSeams): Promise<WorkerResult> { return new SwarmAgentRuntime(seams).run(input, onProgress); }
