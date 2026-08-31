import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

const WORKER_MODEL = "openai-codex/gpt-5.6-luna";
const WORKER_THINKING: ThinkingLevel = "medium";
const MAX_TASKS = 8;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;
const STATE_TYPE = "pi-swarm-state";

interface SwarmTask {
  item: string;
  prompt?: string;
  cwd?: string;
}

interface WorkerResult {
  index: number;
  item: string;
  cwd: string;
  status: "completed" | "failed" | "aborted";
  output: string;
  stderr: string;
  exitCode: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
}

interface SwarmDetails {
  description: string;
  model: string;
  thinking: string;
  concurrency: number;
  results: WorkerResult[];
}

const WorkerTask = Type.Object({
  item: Type.String({ description: "Short item name or bounded work package" }),
  prompt: Type.Optional(Type.String({ description: "Task-specific prompt; overrides promptTemplate" })),
  cwd: Type.Optional(Type.String({ description: "Worker directory; defaults to the parent working directory" })),
});

const SwarmParameters = Type.Object({
  description: Type.String({ description: "Short description of the whole swarm" }),
  tasks: Type.Array(WorkerTask, {
    minItems: 1,
    maxItems: MAX_TASKS,
    description: "Bounded work packages. Prefer one worker; use parallel workers only for genuinely independent work.",
  }),
  promptTemplate: Type.Optional(
    Type.String({ description: "Template for tasks without prompt; replace {{item}} with the item value" }),
  ),
  concurrency: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Concurrent workers; defaults to 2" }),
  ),
});

const WORKER_SYSTEM_PROMPT = `You are a focused worker in a Pi swarm. The parent Pi is the coordinator and final authority.

Follow only the delegated work package. Read repository instructions before editing. Keep scope bounded. Do not create subagents. Never reveal credentials, tokens, private endpoints, device identifiers, private logs, or private content.

Do not deploy, restart services, install to devices, publish branches, open or merge pull requests, mutate production data, or post GitHub status unless the delegated prompt explicitly authorizes that exact action.

If editing, avoid files outside the assigned package and do not overwrite concurrent work. Run focused verification. End with a concise report containing: findings, files changed, tests/commands run and results, unresolved risks, and not done.`;

function executableInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  const bunVirtual = script?.startsWith("/$bunfs/root/");
  if (script && !bunVirtual && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const runtime = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function capOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= OUTPUT_CAP) return value;
  let result = value.slice(0, OUTPUT_CAP);
  while (Buffer.byteLength(result, "utf8") > OUTPUT_CAP) result = result.slice(0, -1);
  return `${result}\n\n[Output truncated; full worker transcript is intentionally not injected into the parent context.]`;
}

function finalAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.find((part: any) => part?.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return "";
}

async function runWorker(
  index: number,
  task: SwarmTask,
  prompt: string,
  defaultCwd: string,
  signal: AbortSignal | undefined,
  update: (result: WorkerResult) => void,
): Promise<WorkerResult> {
  const cwd = task.cwd ?? defaultCwd;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-swarm-"));
  const systemFile = join(tempDir, "worker-system.md");
  await writeFile(systemFile, WORKER_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 });

  const result: WorkerResult = {
    index,
    item: task.item,
    cwd,
    status: "completed",
    output: "",
    stderr: "",
    exitCode: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    model: WORKER_MODEL,
  };
  const messages: any[] = [];

  try {
    const args = [
      "--mode", "json",
      "--print",
      "--no-session",
      "--model", WORKER_MODEL,
      "--thinking", WORKER_THINKING,
      "--append-system-prompt", systemFile,
      prompt,
    ];
    const invocation = executableInvocation(args);
    let aborted = false;

    result.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
            if (event.message.role === "assistant") {
              result.turns += 1;
              const usage = event.message.usage;
              result.inputTokens += usage?.input ?? 0;
              result.outputTokens += usage?.output ?? 0;
              result.cost += usage?.cost?.total ?? 0;
              result.output = capOutput(finalAssistantText(messages));
              update({ ...result });
            }
          } else if (event.type === "tool_result_end" && event.message) {
            messages.push(event.message);
            update({ ...result });
          }
        } catch {
          // Pi JSON mode should emit NDJSON. Ignore non-JSON diagnostics on stdout.
        }
      };

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line);
      });
      child.stderr.on("data", (chunk) => {
        result.stderr += chunk.toString();
      });
      child.on("error", (error) => {
        result.stderr += `${error.message}\n`;
        resolve(1);
      });
      child.on("close", (code) => {
        if (buffer.trim()) consume(buffer);
        resolve(code ?? 1);
      });

      const stop = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });

      child.on("close", () => {
        if (aborted) result.status = "aborted";
      });
    });

    result.output = capOutput(finalAssistantText(messages) || result.stderr.trim() || "(no worker output)");
    if (result.status !== "aborted" && result.exitCode !== 0) result.status = "failed";
    update({ ...result });
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mapLimited<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export default function swarmExtension(pi: ExtensionAPI) {
  let enabled = false;

  const persist = () => pi.appendEntry(STATE_TYPE, { enabled });

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        enabled = Boolean((entry.data as any)?.enabled);
      }
    }
    ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nSWARM MODE IS ACTIVE. You are the coordinator. Use the swarm tool for substantial implementation or investigation that benefits from delegated work. Prefer one Luna worker. Use multiple workers only for independent, non-overlapping packages. Do not delegate production mutations, deployment, device operations, merges, or credential handling. Inspect worker results and diffs yourself before accepting them.`,
    };
  });

  pi.registerCommand("swarm", {
    description: "Toggle Pi swarm mode or start a swarm task: /swarm on|off|status|<task>",
    handler: async (raw, ctx) => {
      const args = raw.trim();
      const lower = args.toLowerCase();
      if (!args || lower === "on" || lower === "off") {
        enabled = lower === "on" ? true : lower === "off" ? false : !enabled;
        persist();
        ctx.ui.setStatus("swarm", enabled ? "🐝 swarm" : undefined);
        ctx.ui.notify(`Swarm mode ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (lower === "status") {
        ctx.ui.notify(
          `Swarm ${enabled ? "ON" : "OFF"} · worker ${WORKER_MODEL} · thinking ${WORKER_THINKING} · default concurrency ${DEFAULT_CONCURRENCY}`,
          "info",
        );
        return;
      }
      enabled = true;
      persist();
      ctx.ui.setStatus("swarm", "🐝 swarm");
      pi.sendUserMessage(`SWARM TASK: ${args}\nAct as coordinator. Delegate only necessary bounded work through the swarm tool, then inspect and integrate the result.`);
    },
  });

  pi.registerTool({
    name: "swarm",
    label: "Swarm",
    description: `Launch a bounded swarm of isolated Pi workers. Workers always use ${WORKER_MODEL} at ${WORKER_THINKING} thinking. Supports 1-${MAX_TASKS} tasks and at most ${MAX_CONCURRENCY} concurrent workers; default concurrency is ${DEFAULT_CONCURRENCY}. Prefer one worker and parallelize only independent packages.`,
    promptSnippet: "Delegate bounded implementation or investigation to cost-controlled Luna workers",
    promptGuidelines: [
      "Use swarm as coordinator-driven delegation; prefer one worker and avoid duplicate review workers.",
      "Never use swarm for credentials, production mutations, deployments, service restarts, device installation, PR merges, or overlapping edits.",
      "After swarm returns, inspect its changes and verification evidence before accepting or continuing.",
    ],
    parameters: SwarmParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const concurrency = Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
      const live: WorkerResult[] = params.tasks.map((task, index) => ({
        index,
        item: task.item,
        cwd: task.cwd ?? ctx.cwd,
        status: "completed",
        output: "(queued)",
        stderr: "",
        exitCode: -1,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        model: WORKER_MODEL,
      }));
      const emit = () => {
        const done = live.filter((item) => item.exitCode !== -1).length;
        onUpdate?.({
          content: [{ type: "text", text: `Swarm: ${done}/${live.length} complete, ${live.length - done} running or queued` }],
          details: { description: params.description, model: WORKER_MODEL, thinking: WORKER_THINKING, concurrency, results: [...live] } satisfies SwarmDetails,
        });
      };
      emit();

      const results = await mapLimited(params.tasks as SwarmTask[], concurrency, async (task, index) => {
        const template = task.prompt ?? params.promptTemplate ?? "Complete this bounded work package: {{item}}";
        const prompt = template.replaceAll("{{item}}", task.item);
        return runWorker(index, task, prompt, ctx.cwd, signal, (partial) => {
          live[index] = partial;
          emit();
        });
      });

      const completed = results.filter((result) => result.status === "completed").length;
      const summaries = results.map((result) =>
        `### Worker ${result.index + 1}: ${result.item} — ${result.status}\n${result.output}`,
      );
      return {
        content: [{ type: "text", text: `Swarm completed: ${completed}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
        details: { description: params.description, model: WORKER_MODEL, thinking: WORKER_THINKING, concurrency, results } satisfies SwarmDetails,
      };
    },
    renderCall(args, theme) {
      const count = args.tasks?.length ?? 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${count} worker${count === 1 ? "" : "s"}`)}\n${theme.fg("dim", args.description ?? "")}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as SwarmDetails | undefined;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      const done = details.results.filter((worker) => worker.exitCode !== -1).length;
      const failed = details.results.filter((worker) => worker.status === "failed" || worker.status === "aborted").length;
      let text = `${isPartial ? "⏳" : failed ? "◐" : "✓"} ${done}/${details.results.length} workers`;
      for (const worker of details.results) {
        const icon = worker.exitCode === -1 ? "⏳" : worker.status === "completed" ? "✓" : "✗";
        text += `\n  ${icon} ${worker.item}`;
        if (worker.turns) text += theme.fg("dim", ` · ${worker.turns} turns · ↓${worker.outputTokens}`);
      }
      text += theme.fg("dim", `\n${details.model} · ${details.thinking} · concurrency ${details.concurrency}`);
      return new Text(text, 0, 0);
    },
  });
}
