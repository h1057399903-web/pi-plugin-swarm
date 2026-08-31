import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { SwarmBatch, type SwarmTaskStatus } from "./features/swarm-batch.ts";
import { SwarmAgentRuntime, WORKER_MODEL, WORKER_THINKING_LEVEL, type WorkerResult } from "./swarm-agent-runtime.ts";
import { getSwarmIntegration, type PublicSwarmRun, type PublicSwarmWorker } from "./public-api.ts";

const MAX_TASKS = 128;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 16;
const INITIAL_LAUNCH_LIMIT = 5;
const LAUNCH_STAGGER_MS = 700;
const STATE_TYPE = "pi-swarm-state";
const REGISTER_KEY = Symbol.for("pi-plugin-swarm.extension.registered.v2");

interface SwarmTask { item: string; prompt?: string; cwd?: string; timeoutMs?: number; }

const WorkerTask = Type.Object({
  item: Type.String({ description: "Short item name or bounded work package" }),
  prompt: Type.Optional(Type.String({ description: "Task-specific prompt; overrides promptTemplate" })),
  cwd: Type.Optional(Type.String({ description: "Worker directory; defaults to the parent working directory" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000, description: "Optional worker timeout" })),
});

const SwarmParameters = Type.Object({
  description: Type.String({ description: "Short description of the whole swarm" }),
  tasks: Type.Array(WorkerTask, { minItems: 1, maxItems: MAX_TASKS, description: "Bounded independent work packages" }),
  promptTemplate: Type.Optional(Type.String({ description: "Template for tasks without prompt; replace {{item}}" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Maximum active workers; defaults to 2" })),
});

function safeError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message.slice(0, 500);
  return "Worker failed.";
}

function publicStatus(status: SwarmTaskStatus): PublicSwarmWorker["status"] {
  return status;
}

function makeWorker(runId: string, task: SwarmTask, index: number): PublicSwarmWorker {
  return {
    workerId: `${runId}:${index + 1}`,
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
  const root = globalThis as typeof globalThis & { [REGISTER_KEY]?: boolean };
  if (root[REGISTER_KEY]) return;
  root[REGISTER_KEY] = true;

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
    integration.setEnabled(enabled);
    ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\nSWARM MODE IS ACTIVE. Coordinate bounded independent work through the swarm tool. Prefer one worker; parallelize only non-overlapping packages. Workers use Luna medium. Inspect their changes and tests yourself. Never delegate credentials, production mutation, deployments, service restarts, device installation, merges, or overlapping edits.` };
  });

  pi.registerCommand("swarm", {
    description: "Toggle Pi Swarm or start a task: /swarm on|off|status|<task>",
    handler: async (raw, ctx) => {
      const args = raw.trim(); const lower = args.toLowerCase();
      if (!args || lower === "on" || lower === "off") {
        applyEnabled(lower === "on" ? true : lower === "off" ? false : !enabled);
        persist(); ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
        ctx.ui.notify(`Swarm mode ${enabled ? "enabled" : "disabled"}.`, "info"); return;
      }
      if (lower === "status") {
        const active = integration.snapshot().runs.filter((run) => run.status === "running").length;
        ctx.ui.notify(`Swarm ${enabled ? "ON" : "OFF"} · ${WORKER_MODEL} · ${WORKER_THINKING_LEVEL} · default ${DEFAULT_CONCURRENCY} · max tasks ${MAX_TASKS} · active runs ${active}`, "info"); return;
      }
      applyEnabled(true); persist(); ctx.ui.setStatus("swarm", "🐝 swarm");
      pi.sendUserMessage(`SWARM TASK: ${args}\nAct as coordinator. Delegate only necessary bounded work through the swarm tool, then inspect and integrate the result.`);
    },
  });

  pi.registerTool({
    name: "swarm",
    label: "Swarm",
    description: `Launch a Kimi-style bounded task swarm using in-process Pi AgentSessions. Supports 1-${MAX_TASKS} tasks, up to ${MAX_CONCURRENCY} active workers, initial burst ${INITIAL_LAUNCH_LIMIT}, then staggered launches. Workers always use ${WORKER_MODEL} at ${WORKER_THINKING_LEVEL}.`,
    promptSnippet: "Delegate bounded independent packages to in-process Luna workers",
    promptGuidelines: [
      "Prefer one worker; parallelize only independent packages with non-overlapping file ownership.",
      "Never delegate credentials, production mutations, deployments, service restarts, device installation, or merges.",
      "Inspect worker changes and verification evidence before accepting them.",
    ],
    parameters: SwarmParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const tasks = params.tasks as SwarmTask[];
      const requestedConcurrency = Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
      const runId = randomUUID();
      const workers = tasks.map((task, index) => makeWorker(runId, task, index));
      const run: PublicSwarmRun = { runId, description: params.description.slice(0, 500), status: "running", createdAt: Date.now(), requestedConcurrency, activeCapacity: requestedConcurrency, workers };

      const publish = () => {
        integration.updateRun(run);
        const done = workers.filter((worker) => ["completed", "failed", "aborted", "rate_limited"].includes(worker.status)).length;
        onUpdate?.({ content: [{ type: "text", text: `Swarm: ${done}/${workers.length} finished` }], details: structuredClone(run) });
      };
      publish();

      const batch = new SwarmBatch(tasks, async (task, context) => {
        const worker = workers[context.index];
        worker.attempt = context.attempt;
        const template = task.prompt ?? params.promptTemplate ?? "Complete this bounded work package: {{item}}";
        const prompt = template.replaceAll("{{item}}", task.item);
        const stop = () => runtime.abort(worker.workerId);
        context.signal.addEventListener("abort", stop, { once: true });
        try {
          const result = await runtime.run({ workerId: worker.workerId, prompt, cwd: task.cwd ?? ctx.cwd, item: task.item, timeoutMs: task.timeoutMs }, (progress) => {
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
        signal,
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

      const results = await batch.run();
      run.finishedAt = Date.now();
      run.status = signal?.aborted || results.every((result) => result.status === "aborted") ? "aborted"
        : results.some((result) => result.status === "failed" || result.status === "rate_limited") ? "failed" : "completed";
      publish();
      const completed = workers.filter((worker) => worker.status === "completed").length;
      const summaries = workers.map((worker) => `### Worker ${worker.index + 1}: ${worker.item} — ${worker.status}\n${worker.output || worker.error || "(no output)"}`);
      return { content: [{ type: "text", text: `Swarm completed: ${completed}/${workers.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: structuredClone(run) };
    },
    renderCall(args, theme) {
      const count = args.tasks?.length ?? 0;
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
