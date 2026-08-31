import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { SwarmBatch, type SwarmTaskStatus } from "./features/swarm-batch.ts";
import { SwarmAgentRuntime, WORKER_MODEL, WORKER_THINKING_LEVEL, type WorkerResult } from "./swarm-agent-runtime.ts";
import { getSwarmIntegration, type PublicSwarmRun, type PublicSwarmWorker } from "./public-api.ts";

const MAX_TASKS = 128;
const MAX_CONCURRENCY = 16;
const INITIAL_LAUNCH_LIMIT = 5;
const LAUNCH_STAGGER_MS = 700;
const STATE_TYPE = "pi-swarm-state";
const RUN_STATE_TYPE = "pi-swarm-run-v1";

interface SwarmTask { item: string; prompt?: string; cwd?: string; timeoutMs?: number; agentId?: string; resume?: boolean; }

const WorkerTask = Type.Object({
  item: Type.String({ description: "Short item name or bounded work package" }),
  prompt: Type.Optional(Type.String({ description: "Task-specific prompt; overrides promptTemplate" })),
  cwd: Type.Optional(Type.String({ description: "Worker directory; defaults to the parent working directory" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000, description: "Optional worker timeout" })),
});

const ResumeAgentMap = Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), { maxProperties: MAX_TASKS, description: "Map of prior agent ID to its follow-up prompt; resumed workers launch first" });

const SwarmParameters = Type.Object({
  description: Type.String({ description: "Short description of the whole swarm" }),
  tasks: Type.Optional(Type.Array(WorkerTask, { minItems: 1, maxItems: MAX_TASKS, description: "Bounded independent work packages" })),
  items: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_TASKS, description: "Kimi-compatible shorthand: each item launches one new worker" })),
  resumeAgentIds: Type.Optional(ResumeAgentMap),
  resume_agent_ids: Type.Optional(ResumeAgentMap),
  fork: Type.Optional(Type.Boolean({ description: "Fork the current parent conversation into every new worker; incompatible with resume agent IDs" })),
  promptTemplate: Type.Optional(Type.String({ description: "Template for tasks without prompt; replace {{item}}" })),
  prompt_template: Type.Optional(Type.String({ description: "Kimi-compatible alias for promptTemplate" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Maximum active workers; defaults to min(total workers, 16)" })),
});

export function resolveSwarmConcurrency(totalWorkers: number, requested?: number): number {
  return Math.max(1, Math.min(requested ?? totalWorkers, MAX_CONCURRENCY));
}

export function countSwarmWorkers(args: {
  tasks?: readonly unknown[]; items?: readonly unknown[];
  resumeAgentIds?: Readonly<Record<string, unknown>>; resume_agent_ids?: Readonly<Record<string, unknown>>;
}): number {
  const resumed = { ...(args.resume_agent_ids ?? {}), ...(args.resumeAgentIds ?? {}) };
  return (args.tasks?.length ?? 0) + (args.items?.length ?? 0) + Object.keys(resumed).length;
}

function safeError(value: unknown): string {
  if (value instanceof Error && ["Worker failed.", "Worker timed out.", "Worker session is unavailable.", "Worker session is busy.", "Provider rate limit."].includes(value.message)) return value.message;
  return "Worker failed.";
}

function publicStatus(status: SwarmTaskStatus): PublicSwarmWorker["status"] {
  return status;
}

function makeWorker(runId: string, task: SwarmTask, index: number, resumable: boolean): PublicSwarmWorker {
  return {
    workerId: `${runId}:${index + 1}`,
    agentId: task.agentId ?? randomUUID(),
    resumed: task.resume === true,
    resumable,
    index,
    item: task.item.slice(0, 200),
    status: "queued",
    attempt: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
    model: WORKER_MODEL,
    thinking: WORKER_THINKING_LEVEL,
  };
}

export function registerSwarmExtension(pi: ExtensionAPI): void {
  const runtime = new SwarmAgentRuntime();
  const integration = getSwarmIntegration();
  let enabled = false;
  const persist = () => pi.appendEntry(STATE_TYPE, { enabled });
  const applyEnabled = (next: boolean) => { enabled = next; integration.setEnabled(next); };

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) enabled = Boolean((entry.data as { enabled?: unknown })?.enabled);
    }
    integration.clearRuns();
    integration.setEnabled(enabled);
    ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\nSWARM MODE IS ACTIVE. Use the swarm tool when work can be split into useful bounded packages. Run as many packages concurrently as are genuinely independent; use one worker only for a single or serial package. Workers use Luna medium. Inspect their changes and tests yourself. Never delegate credentials, production mutation, deployments, service restarts, device installation, merges, or overlapping edits.` };
  });

  pi.registerCommand("swarm", {
    description: "Toggle/start/cancel Pi Swarm: /swarm on|off|status|cancel <run-id>|<task>",
    handler: async (raw, ctx) => {
      const args = raw.trim(); const lower = args.toLowerCase();
      if (!args || lower === "on" || lower === "off") {
        applyEnabled(lower === "on" ? true : lower === "off" ? false : !enabled);
        persist(); ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
        ctx.ui.notify(`Swarm mode ${enabled ? "enabled" : "disabled"}.`, "info"); return;
      }
      if (lower === "status") {
        const active = integration.snapshot().runs.filter((run) => run.status === "running").length;
        ctx.ui.notify(`Swarm ${enabled ? "ON" : "OFF"} · ${WORKER_MODEL} · ${WORKER_THINKING_LEVEL} · default adaptive up to ${MAX_CONCURRENCY} · max tasks ${MAX_TASKS} · active runs ${active}`, "info"); return;
      }
      if (lower.startsWith("cancel ")) {
        const runId = args.slice(7).trim();
        ctx.ui.notify(integration.cancelRun(runId) ? `Cancelling swarm ${runId}.` : `No active swarm ${runId}.`, integration.snapshot().runs.some((run) => run.runId === runId) ? "info" : "warning");
        return;
      }
      applyEnabled(true); persist(); ctx.ui.setStatus("swarm", "🐝 swarm");
      pi.sendUserMessage(`SWARM TASK: ${args}\nAct as coordinator. Delegate only necessary bounded work through the swarm tool, then inspect and integrate the result.`);
    },
  });

  pi.registerTool({
    name: "swarm",
    label: "Swarm",
    description: `Launch or resume a Kimi-style bounded task swarm using in-process Pi AgentSessions. Supports 1-${MAX_TASKS} tasks, up to ${MAX_CONCURRENCY} active workers, stable resumable agent IDs, optional parent-context fork, initial burst ${INITIAL_LAUNCH_LIMIT}, then staggered launches. Workers always use ${WORKER_MODEL} at ${WORKER_THINKING_LEVEL}.`,
    promptSnippet: "Delegate bounded independent packages to in-process Luna workers",
    promptGuidelines: [
      "Use as many workers as are useful for independent packages with non-overlapping file ownership; use one only for a single or serial package.",
      "Never delegate credentials, production mutations, deployments, service restarts, device installation, or merges.",
      "Inspect worker changes and verification evidence before accepting them.",
      "Use resume_agent_ids for follow-up work by a prior worker; use fork only when every new worker requires the parent conversation context.",
    ],
    parameters: SwarmParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const shorthandTasks: SwarmTask[] = (params.items ?? []).map((item) => ({ item }));
      const newTasks = [...((params.tasks ?? []) as SwarmTask[]), ...shorthandTasks];
      const resumeMap = { ...(params.resume_agent_ids ?? {}), ...(params.resumeAgentIds ?? {}) };
      const resumedTasks: SwarmTask[] = Object.entries(resumeMap).map(([agentId, prompt]) => ({ item: `Resume ${agentId}`, prompt, agentId, resume: true }));
      if (params.fork && resumedTasks.length) throw new Error("fork cannot be combined with resumeAgentIds");
      const tasks = [...resumedTasks, ...newTasks];
      if (!tasks.length) throw new Error("Provide at least one task or resumeAgentIds entry");
      if (tasks.length > MAX_TASKS) throw new Error(`A swarm may contain at most ${MAX_TASKS} workers`);
      const ownerSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const resumable = Boolean(parentSessionFile);
      const forkSessionFile = params.fork ? parentSessionFile : undefined;
      if (params.fork && !forkSessionFile) throw new Error("Fork requires a persisted parent session");
      if (resumedTasks.length && !resumable) throw new Error("Resume requires a persisted parent session");
      const requestedConcurrency = resolveSwarmConcurrency(tasks.length, params.concurrency);
      const runId = randomUUID();
      const workers = tasks.map((task, index) => makeWorker(runId, task, index, resumable));
      const run: PublicSwarmRun = { runId, description: params.description.slice(0, 500), status: "running", createdAt: Date.now(), requestedConcurrency, activeCapacity: requestedConcurrency, workers };

      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPublishedAt = -Infinity;
      const publishNow = () => {
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = undefined; }
        lastPublishedAt = Date.now();
        integration.updateRun(run);
        const done = workers.filter((worker) => ["completed", "failed", "aborted", "rate_limited"].includes(worker.status)).length;
        onUpdate?.({ content: [{ type: "text", text: `Swarm: ${done}/${workers.length} finished` }], details: structuredClone(run) });
      };
      const publish = (immediate = false) => {
        const delay = 250 - (Date.now() - lastPublishedAt);
        if (immediate || delay <= 0) publishNow();
        else if (!publishTimer) publishTimer = setTimeout(publishNow, delay);
      };
      publish(true);
      const runController = new AbortController();
      integration.setRunController(runId, () => runController.abort(new Error("Swarm run cancelled.")));
      const runSignal = signal ? AbortSignal.any([signal, runController.signal]) : runController.signal;

      const batch = new SwarmBatch(tasks, async (task, context) => {
        const worker = workers[context.index];
        worker.attempt = context.attempt;
        const template = task.prompt ?? params.promptTemplate ?? params.prompt_template ?? "Complete this bounded work package: {{item}}";
        const prompt = template.replaceAll("{{item}}", task.item);
        const stop = () => runtime.abort(worker.workerId);
        context.signal.addEventListener("abort", stop, { once: true });
        try {
          const result = await runtime.run({
            workerId: worker.workerId,
            agentId: worker.agentId,
            ownerSessionId,
            persist: resumable,
            resume: task.resume === true || context.attempt > 1,
            forkSessionFile: task.resume ? undefined : forkSessionFile,
            prompt,
            cwd: task.cwd ?? ctx.cwd,
            item: task.item,
            timeoutMs: task.timeoutMs,
          }, (progress) => {
            worker.status = progress.status;
            worker.turns = progress.turns;
            if (progress.output) worker.output = progress.output;
            if (progress.status === "running" && worker.startedAt === undefined) worker.startedAt = Date.now();
            publish();
          });
          applyWorkerResult(worker, result);
          publish();
          if (result.status === "failed") throw new Error(result.error || "Worker failed.");
          if (result.status === "aborted") throw Object.assign(new Error("Worker aborted."), { name: "AbortError" });
          return result;
        } finally {
          context.signal.removeEventListener("abort", stop);
        }
      }, {
        maxConcurrency: requestedConcurrency,
        initialLaunchLimit: Math.min(INITIAL_LAUNCH_LIMIT, requestedConcurrency),
        launchStaggerMs: LAUNCH_STAGGER_MS,
        maxRetries: 3,
        retryBaseMs: 3_000,
        capacityRecoveryMs: 180_000,
        signal: runSignal,
        isRateLimitedResult: (result) => result.status === "rate_limited",
        onProgress: (progress) => {
          run.activeCapacity = progress.capacity;
          for (const result of progress.results) {
            const worker = workers[result.index];
            worker.attempt = result.attempts;
            if (!result.value || result.status !== "completed") worker.status = publicStatus(result.status);
            if (result.error) worker.error = safeError(result.error);
          }
          publish();
        },
      });

      let results;
      try { results = await batch.run(); }
      finally { integration.setRunController(runId, undefined); }
      run.finishedAt = Date.now();
      run.status = runSignal.aborted || results.every((result) => result.status === "aborted") ? "aborted"
        : results.some((result) => result.status === "failed" || result.status === "rate_limited") ? "failed" : "completed";
      publish(true);
      pi.appendEntry(RUN_STATE_TYPE, {
        runId: run.runId,
        description: run.description,
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        requestedConcurrency: run.requestedConcurrency,
        activeCapacity: run.activeCapacity,
        workers: run.workers.map(({ output: _output, error: _error, ...worker }) => worker),
      });
      const completed = workers.filter((worker) => worker.status === "completed").length;
      const summaries = workers.map((worker) => `### Worker ${worker.index + 1}: ${worker.item} — ${worker.status}\nAgent ID: ${worker.agentId}${worker.resumable ? " (resumable)" : ""}\n${worker.output || worker.error || "(no output)"}`);
      return { content: [{ type: "text", text: `Swarm completed: ${completed}/${workers.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: structuredClone(run) };
    },
    renderCall(args, theme) {
      const count = countSwarmWorkers(args);
      return new Text(`${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${count} worker${count === 1 ? "" : "s"}`)}\n${theme.fg("dim", args.description ?? "")}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const run = result.details as PublicSwarmRun | undefined;
      if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      const done = run.workers.filter((worker) => ["completed", "failed", "aborted", "rate_limited"].includes(worker.status)).length;
      const failed = run.workers.some((worker) => worker.status === "failed" || worker.status === "rate_limited");
      let text = `${isPartial ? "⏳" : failed ? "◐" : "✓"} ${done}/${run.workers.length} workers`;
      for (const worker of run.workers) {
        const icon = worker.status === "completed" ? "✓" : worker.status === "failed" || worker.status === "rate_limited" ? "✗" : worker.status === "aborted" ? "■" : "⏳";
        text += `\n  ${icon} ${worker.item}`;
        if (worker.turns) text += theme.fg("dim", ` · ${worker.turns} turns · ↓${worker.outputTokens}`);
      }
      text += theme.fg("dim", `\n${WORKER_MODEL} · ${WORKER_THINKING_LEVEL} · capacity ${run.activeCapacity}/${run.requestedConcurrency}`);
      return new Text(text, 0, 0);
    },
  });
}

function applyWorkerResult(worker: PublicSwarmWorker, result: WorkerResult): void {
  worker.agentId = result.agentId;
  worker.resumable = result.resumable;
  worker.status = result.status;
  worker.startedAt = result.startedAt;
  worker.finishedAt = result.finishedAt;
  worker.durationMs = result.durationMs;
  worker.turns = result.turns;
  worker.inputTokens = result.usage.input;
  worker.outputTokens = result.usage.output;
  worker.cacheReadTokens = result.usage.cacheRead;
  worker.cost = result.usage.cost;
  worker.output = result.output;
  worker.error = result.error;
}

export default registerSwarmExtension;
export * from "./public-api.ts";
