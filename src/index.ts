import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { SwarmBatch, type SwarmTaskStatus } from "./features/swarm-batch.ts";
import { SwarmAgentRuntime, WORKER_MODEL, WORKER_THINKING_LEVEL, parseWorkerModel, type WorkerProviderRegistration, type WorkerResult } from "./swarm-agent-runtime.ts";
import { getSwarmIntegration, type PublicSwarmRun, type PublicSwarmWorker } from "./public-api.ts";
import { LightweightCoordination } from "./lightweight-coordination.ts";

const MAX_TASKS = 128;
const MAX_CONCURRENCY = 16;
const INITIAL_LAUNCH_LIMIT = 5;
const LAUNCH_STAGGER_MS = 700;
const STATE_TYPE = "pi-swarm-state";
const RUN_STATE_TYPE = "pi-swarm-run-v1";

export type SwarmSubagentType = "explore" | "coder";
interface SwarmTask { item: string; prompt?: string; cwd?: string; timeoutMs?: number; agentId?: string; resume?: boolean; subagent_type?: SwarmSubagentType; }
interface ModelLike { provider?: unknown; id?: unknown; name?: unknown; }
interface WorkerModelChoice { value: string; label: string; model: ModelLike; }
interface WorkerModelContext {
  scopedModels?: readonly { model?: ModelLike }[];
  modelRegistry?: { getAvailable?: () => readonly ModelLike[] };
}
export interface SelectableWorkerModel { value: string; label: string; }

function selectableWorkerModelChoices(context: WorkerModelContext): WorkerModelChoice[] {
  const scoped = context.scopedModels ?? [];
  const models = scoped.length > 0 ? scoped.map((entry) => entry.model) : context.modelRegistry?.getAvailable?.() ?? [];
  const choices = new Map<string, WorkerModelChoice>();
  for (const model of models) {
    if (typeof model?.provider !== "string" || typeof model.id !== "string") continue;
    const value = `${model.provider}/${model.id}`;
    if (!parseWorkerModel(value) || choices.has(value)) continue;
    const name = typeof model.name === "string" ? model.name.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100) : "";
    choices.set(value, { value, label: name && name !== model.id && name !== value ? `${value} — ${name}` : value, model });
  }
  return [...choices.values()].sort((left, right) => left.value.localeCompare(right.value));
}

export function listSelectableWorkerModels(context: WorkerModelContext): SelectableWorkerModel[] {
  return selectableWorkerModelChoices(context).map(({ value, label }) => ({ value, label }));
}

/** Guidance deliberately lives in the coordinator, rather than in user task text. */
export const COORDINATOR_GUIDANCE = "Act as the swarm coordinator: split only genuinely independent, bounded work; assign non-overlapping ownership; inspect every result and verification signal; integrate the work yourself. Do not ask workers to spawn workers or delegate further.";
const WORKER_GUIDANCE = "Complete only the supplied bounded work package and report the result to the coordinator. Do not coordinate other packages, spawn workers, or delegate further.";

export function renderSwarmTaskPrompt(task: Pick<SwarmTask, "item" | "prompt" | "subagent_type">, promptTemplate?: string, prompt_template?: string): string {
  const template = task.prompt ?? promptTemplate ?? prompt_template ?? "Complete this bounded work package: {{item}}";
  return template.replaceAll("{{item}}", task.item);
}

/** Reject accidental duplicate work before any session is created. Resumes are excluded by the caller. */
export function validateUniqueRenderedPrompts(tasks: readonly SwarmTask[], promptTemplate?: string, prompt_template?: string): string[] {
  const seen = new Map<string, number>();
  const rendered = tasks.map((task, index) => {
    const prompt = renderSwarmTaskPrompt(task, promptTemplate, prompt_template);
    const previous = seen.get(prompt);
    if (previous !== undefined) throw new Error(`Duplicate rendered prompt for new tasks ${previous + 1} and ${index + 1}`);
    seen.set(prompt, index);
    return prompt;
  });
  return rendered;
}

export function resumeAgentIdsHint(workers: readonly Pick<PublicSwarmWorker, "agentId" | "item" | "status" | "resumable">[]): string {
  const unfinished = workers.filter((worker) => worker.resumable && worker.status !== "completed");
  if (!unfinished.length) return "";
  const ids = Object.fromEntries(unfinished.map((worker) => [worker.agentId, `Continue the unfinished work package: ${worker.item}`]));
  return `resume_agent_ids: ${JSON.stringify(ids)}`;
}

const WorkerTask = Type.Object({
  item: Type.String({ description: "Short item name or bounded work package" }),
  prompt: Type.Optional(Type.String({ description: "Task-specific prompt; overrides promptTemplate" })),
  cwd: Type.Optional(Type.String({ description: "Worker directory; defaults to the parent working directory" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000, description: "Optional worker timeout" })),
  subagent_type: Type.Optional(StringEnum(["explore", "coder"] as const, { description: "Enforced capability profile: explore is read-only; coder can read, run commands, edit, and write. Defaults to coder." })),
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
  if (value instanceof Error && ["Worker failed.", "Worker timed out.", "Worker session is unavailable.", "Worker session is busy.", "Worker cwd is outside the parent working directory.", "Provider rate limit."].includes(value.message)) return value.message;
  return "Worker failed.";
}

function publicStatus(status: SwarmTaskStatus): PublicSwarmWorker["status"] {
  return status;
}

interface InternalSwarmWorker extends PublicSwarmWorker { output?: string; error?: string; }

function makeWorker(runId: string, task: SwarmTask, index: number, resumable: boolean, model: string): InternalSwarmWorker {
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
    model,
    thinking: WORKER_THINKING_LEVEL,
    toolCalls: {},
    touchedFiles: [],
    overlapFiles: [],
  };
}

export function registerSwarmExtension(pi: ExtensionAPI): void {
  const runtime = new SwarmAgentRuntime();
  const integration = getSwarmIntegration();
  let enabled = false;
  let workerModel = WORKER_MODEL;
  const persist = () => pi.appendEntry(STATE_TYPE, { enabled, workerModel });
  const applyEnabled = (next: boolean) => { enabled = next; integration.setEnabled(next); };

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    workerModel = WORKER_MODEL;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { enabled?: unknown; workerModel?: unknown };
      enabled = Boolean(data?.enabled);
      const restoredModel = parseWorkerModel(data?.workerModel);
      workerModel = restoredModel?.value ?? WORKER_MODEL;
    }
    integration.clearRuns();
    integration.setEnabled(enabled);
    ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
    const choices = listSelectableWorkerModels(ctx);
    if (workerModel !== WORKER_MODEL && choices.length > 0 && !choices.some((choice) => choice.value === workerModel)) {
      ctx.ui.notify(`Saved worker model ${workerModel} is not available in this Pi session. Choose another with /swarm model.`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\nSWARM MODE IS ACTIVE. ${COORDINATOR_GUIDANCE} Workers use ${workerModel} at ${WORKER_THINKING_LEVEL}. Never delegate credentials, production mutation, deployments, service restarts, device installation, merges, or overlapping edits.` };
  });

  pi.registerCommand("swarm", {
    description: "Configure/start/cancel Pi Swarm: /swarm on|off|status|model|cancel <run-id>|<task>",
    getArgumentCompletions: (prefix) => {
      const commands = [
        { value: "on", label: "on", description: "Enable Swarm mode" },
        { value: "off", label: "off", description: "Disable Swarm mode" },
        { value: "status", label: "status", description: "Show Swarm status" },
        { value: "model", label: "model", description: "Choose the worker model" },
        { value: "cancel ", label: "cancel <run-id>", description: "Cancel an active Swarm run" },
      ];
      const matches = commands.filter((command) => command.value.startsWith(prefix.toLowerCase()));
      return matches.length ? matches : null;
    },
    handler: async (raw, ctx) => {
      const args = raw.trim(); const lower = args.toLowerCase();
      if (!args || lower === "on" || lower === "off") {
        applyEnabled(lower === "on" ? true : lower === "off" ? false : !enabled);
        persist(); ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
        ctx.ui.notify(`Swarm mode ${enabled ? "enabled" : "disabled"}.`, "info"); return;
      }
      if (lower === "status") {
        const active = integration.snapshot().runs.filter((run) => run.status === "running").length;
        ctx.ui.notify(`Swarm ${enabled ? "ON" : "OFF"} · ${workerModel} · ${WORKER_THINKING_LEVEL} · default adaptive up to ${MAX_CONCURRENCY} · max tasks ${MAX_TASKS} · active runs ${active}`, "info"); return;
      }
      if (lower === "model" || lower.startsWith("model ")) {
        const choices = listSelectableWorkerModels(ctx);
        let requested = args.slice("model".length).trim();
        if (!requested) {
          if (!ctx.hasUI) {
            ctx.ui.notify("Specify a worker model as provider/model, or run /swarm model in interactive mode.", "warning"); return;
          }
          if (!choices.length) {
            ctx.ui.notify("No worker models are available in this Pi session.", "warning"); return;
          }
          const selected = await ctx.ui.select(`Worker model (current: ${workerModel})`, choices.map((choice) => choice.label));
          if (!selected) return;
          requested = choices.find((choice) => choice.label === selected)?.value ?? "";
        } else if (requested.toLowerCase() === "reset") {
          requested = WORKER_MODEL;
        }
        const parsed = parseWorkerModel(requested);
        if (!parsed || !choices.some((choice) => choice.value === parsed.value)) {
          ctx.ui.notify(`Worker model ${requested || "(empty)"} is not available in this Pi session.`, "warning"); return;
        }
        workerModel = parsed.value;
        persist();
        ctx.ui.notify(`Swarm worker model set to ${workerModel}.`, "info"); return;
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
    description: `Launch or resume a Kimi-style bounded task swarm using in-process Pi AgentSessions. Supports 1-${MAX_TASKS} tasks, up to ${MAX_CONCURRENCY} active workers, stable resumable agent IDs, optional parent-context fork, initial burst ${INITIAL_LAUNCH_LIMIT}, then staggered launches. Workers use the session-selected model (default ${WORKER_MODEL}) at ${WORKER_THINKING_LEVEL}.`,
    promptSnippet: "Delegate bounded independent packages to in-process Pi workers",
    promptGuidelines: [
      "Use as many workers as are useful for independent packages with non-overlapping file ownership; use one only for a single or serial package.",
      "Use subagent_type explore for read-only investigation and coder only when the worker must run commands or modify files.",
      "Never delegate credentials, production mutations, deployments, service restarts, device installation, or merges.",
      "Inspect worker changes and verification evidence before accepting them.",
      "Use resume_agent_ids for follow-up work by a prior worker; use fork only when every new worker requires the parent conversation context.",
    ],
    parameters: SwarmParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!enabled) {
        return { content: [{ type: "text", text: "Swarm mode is disabled. Run /swarm on before launching workers." }], details: { disabled: true }, isError: true };
      }
      const shorthandTasks: SwarmTask[] = (params.items ?? []).map((item) => ({ item }));
      const newTasks = [...((params.tasks ?? []) as SwarmTask[]), ...shorthandTasks];
      // Only newly-created workers participate: a resume prompt is intentionally allowed
      // to resemble an earlier task while repairing that worker.
      validateUniqueRenderedPrompts(newTasks, params.promptTemplate, params.prompt_template);
      const resumeMap = { ...(params.resume_agent_ids ?? {}), ...(params.resumeAgentIds ?? {}) };
      const resumedTasks: SwarmTask[] = Object.entries(resumeMap).map(([agentId, prompt]) => ({ item: `Resume ${agentId}`, prompt, agentId, resume: true }));
      if (params.fork && resumedTasks.length) throw new Error("fork cannot be combined with resumeAgentIds");
      const tasks = [...resumedTasks, ...newTasks];
      if (!tasks.length) throw new Error("Provide at least one task or resumeAgentIds entry");
      if (tasks.length > MAX_TASKS) throw new Error(`A swarm may contain at most ${MAX_TASKS} workers`);
      const runWorkerModel = workerModel;
      const choices = selectableWorkerModelChoices(ctx);
      const canValidateModel = choices.length > 0 || typeof ctx.modelRegistry?.getAvailable === "function" || (ctx.scopedModels?.length ?? 0) > 0;
      const modelChoice = choices.find((choice) => choice.value === runWorkerModel);
      if (canValidateModel && !modelChoice) {
        throw new Error(`Selected worker model ${runWorkerModel} is not available in this Pi session. Choose another with /swarm model.`);
      }
      const parsedWorkerModel = parseWorkerModel(runWorkerModel);
      if (!parsedWorkerModel) throw new Error("Selected worker model is invalid. Choose another with /swarm model.");
      const nativeProvider = ctx.modelRegistry?.getRegisteredNativeProvider?.(parsedWorkerModel.provider);
      const providerConfig = nativeProvider ? undefined : ctx.modelRegistry?.getRegisteredProviderConfig?.(parsedWorkerModel.provider);
      let providerRegistration: WorkerProviderRegistration | undefined;
      if (nativeProvider) providerRegistration = { native: nativeProvider };
      else if (providerConfig) providerRegistration = { config: providerConfig };
      const ownerSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const resumable = Boolean(parentSessionFile);
      const forkSessionFile = params.fork ? parentSessionFile : undefined;
      if (params.fork && !forkSessionFile) throw new Error("Fork requires a persisted parent session");
      if (resumedTasks.length && !resumable) throw new Error("Resume requires a persisted parent session");
      const requestedConcurrency = resolveSwarmConcurrency(tasks.length, params.concurrency);
      const runId = randomUUID();
      const workers = tasks.map((task, index) => {
        const worker = makeWorker(runId, task, index, resumable, runWorkerModel);
        if (!task.resume) worker.profile = task.subagent_type ?? "coder";
        return worker;
      });
      const run: PublicSwarmRun = { runId, description: params.description.slice(0, 500), status: "running", createdAt: Date.now(), requestedConcurrency, activeCapacity: requestedConcurrency, workers };
      const coordination = new LightweightCoordination();
      const workersById = new Map(workers.map((worker) => [worker.workerId, worker]));

      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPublishedAt = -Infinity;
      const publishNow = () => {
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = undefined; }
        lastPublishedAt = Date.now();
        integration.updateRun(run);
        const done = workers.filter((worker) => ["completed", "failed", "aborted", "rate_limited", "blocked"].includes(worker.status)).length;
        const publicRun = integration.snapshot().runs.find((candidate) => candidate.runId === runId);
        onUpdate?.({ content: [{ type: "text", text: `Swarm: ${done}/${workers.length} finished` }], details: publicRun });
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
        const role = task.resume
          ? "Resume under the capability profile persisted with this worker."
          : `You are a ${task.subagent_type ?? "coder"} worker with an enforced runtime capability profile.`;
        const prompt = `${WORKER_GUIDANCE}\n${role}\n\n${renderSwarmTaskPrompt(task, params.promptTemplate, params.prompt_template)}`;
        const stop = () => runtime.abort(worker.workerId);
        context.signal.addEventListener("abort", stop, { once: true });
        try {
          const result = await runtime.run({
            workerId: worker.workerId,
            agentId: worker.agentId,
            ownerSessionId,
            persist: resumable,
            parentCwd: ctx.cwd,
            resume: task.resume === true || context.attempt > 1,
            forkSessionFile: task.resume ? undefined : forkSessionFile,
            prompt,
            cwd: task.cwd ?? ctx.cwd,
            item: task.item,
            timeoutMs: task.timeoutMs,
            model: runWorkerModel,
            modelDefinition: modelChoice?.model,
            providerRegistration,
            profile: task.resume ? undefined : task.subagent_type ?? "coder",
            onWriteTarget: (target) => {
              const update = coordination.recordWrite(worker.workerId, target);
              for (const affectedWorkerId of update.affectedWorkerIds) {
                const affectedWorker = workersById.get(affectedWorkerId);
                if (!affectedWorker) continue;
                const snapshot = coordination.snapshot(affectedWorkerId);
                affectedWorker.touchedFiles = snapshot.touchedFiles;
                affectedWorker.overlapFiles = snapshot.overlapFiles;
              }
              publish();
            },
          }, (progress) => {
            worker.status = progress.status;
            worker.turns = progress.turns;
            worker.toolCalls = progress.toolCalls;
            worker.currentTool = progress.currentTool;
            worker.currentTarget = progress.currentTarget;
            if (progress.lastActivityAt !== undefined) worker.lastActivityAt = progress.lastActivityAt;
            if (progress.question) worker.question = progress.question;
            if (typeof progress.item === "string" && progress.item) worker.item = progress.item.slice(0, 200);
            if (progress.profile !== undefined) worker.profile = publicProfile(progress.profile);
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
      if (runSignal.aborted || results.every((result) => result.status === "aborted")) run.status = "aborted";
      else if (results.some((result) => result.status === "failed" || result.status === "rate_limited")) run.status = "failed";
      else if (workers.some((worker) => worker.status === "blocked")) run.status = "blocked";
      else run.status = "completed";
      publish(true);
      const publicRun = integration.snapshot().runs.find((candidate) => candidate.runId === runId);
      if (publicRun) pi.appendEntry(RUN_STATE_TYPE, publicRun);
      const publicWorkers = new Map(publicRun?.workers.map((worker) => [worker.workerId, worker]));
      const completed = workers.filter((worker) => worker.status === "completed").length;
      const summaries = workers.map((worker) => {
        const publicWorker = publicWorkers.get(worker.workerId);
        const result = worker.question
          ? `Question: ${publicWorker?.question ?? "[redacted]"}`
          : worker.output || worker.error || "(no output)";
        return `### Worker ${worker.index + 1}: ${publicWorker?.item ?? "[redacted]"} — ${worker.status}\nAgent ID: ${worker.agentId}${worker.resumable ? " (resumable)" : ""}\n${result}`;
      });
      const resumeHint = resumeAgentIdsHint(publicRun?.workers ?? []);
      coordination.clear();
      return { content: [{ type: "text", text: `Swarm completed: ${completed}/${workers.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${resumeHint ? `\n\nUnfinished resumable workers can be continued with:\n${resumeHint}` : ""}` }], details: publicRun };
    },
    renderCall(args, theme) {
      const count = countSwarmWorkers(args);
      return new Text(`${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${count} worker${count === 1 ? "" : "s"}`)}\n${theme.fg("dim", args.description ?? "")}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const run = result.details as PublicSwarmRun | undefined;
      if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      const done = run.workers.filter((worker) => ["completed", "failed", "aborted", "rate_limited", "blocked"].includes(worker.status)).length;
      const failed = run.workers.some((worker) => worker.status === "failed" || worker.status === "rate_limited");
      let text = `${isPartial ? "⏳" : failed ? "◐" : "✓"} ${done}/${run.workers.length} workers`;
      for (const worker of run.workers) {
        const status = worker.status as string;
        const icon = status === "completed" ? "✓" : status === "failed" || status === "rate_limited" ? "✗" : status === "aborted" ? "■" : status === "blocked" ? "?" : status === "suspended" ? "Ⅱ" : "⏳";
        text += `\n  ${icon} ${worker.item}${status === "suspended" ? " (suspended)" : ""}`;
        if (worker.turns) text += theme.fg("dim", ` · ${worker.turns} turns · ↓${worker.outputTokens}`);
      }
      text += theme.fg("dim", `\n${run.workers[0]?.model ?? WORKER_MODEL} · ${WORKER_THINKING_LEVEL} · capacity ${run.activeCapacity}/${run.requestedConcurrency}`);
      const hint = resumeAgentIdsHint(run.workers);
      if (hint) text += theme.fg("dim", `\n${hint}`);
      return new Text(text, 0, 0);
    },
  });
}

function applyWorkerResult(worker: InternalSwarmWorker, result: WorkerResult): void {
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
  worker.toolCalls = result.toolCalls;
  worker.currentTool = result.currentTool;
  worker.currentTarget = result.currentTarget;
  if (result.lastActivityAt !== undefined) worker.lastActivityAt = result.lastActivityAt;
  if (result.question) worker.question = result.question;
  worker.output = result.output;
  worker.error = result.error;
  const recovered = result as WorkerResult & { item?: unknown; profile?: unknown };
  if (typeof recovered.item === "string" && recovered.item) worker.item = recovered.item.slice(0, 200);
  if (recovered.profile !== undefined) worker.profile = publicProfile(recovered.profile);
}

function publicProfile(profile: unknown): PublicSwarmWorker["profile"] {
  return profile === "explore" ? "explore" : "coder";
}

export default registerSwarmExtension;
export * from "./public-api.ts";
