import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSwarmExtension from "../src/index.ts";
import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";

function fakePi() {
  const handlers = new Map(); const commandDefs = []; const toolDefs = []; const entries = [];
  return {
    handlers, commandDefs, toolDefs, entries,
    on(type, handler) { const list = handlers.get(type) || []; list.push(handler); handlers.set(type, list); },
    registerCommand(_name, definition) { commandDefs.push(definition); },
    registerTool(tool) { toolDefs.push(tool); },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendUserMessage() {},
  };
}

function context(available) {
  const notifications = [];
  return {
    cwd: process.cwd(),
    model: available[0],
    thinkingLevel: "medium",
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => available,
      find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "pi-swarm-state", data: { enabled: true } }],
      getSessionId: () => "owner",
      getSessionFile: () => undefined,
    },
    notifications,
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
}

const dir = mkdtempSync(join(tmpdir(), "swarm-model-pool-registration-"));
const configPath = join(dir, "private-pool.json");
const previous = process.env.PI_SWARM_MODEL_POOL;
writeFileSync(configPath, JSON.stringify({
  defaultModel: "durable-coder",
  models: {
    "free-research": { target: "synthetic/free-endpoint", description: "free broad research", costClass: "free" },
    "durable-coder": { target: "synthetic/durable-endpoint", description: "routine coding with durable quota", costClass: "subscription" },
  },
}));
process.env.PI_SWARM_MODEL_POOL = configPath;

const available = [
  { provider: "synthetic", id: "free-endpoint", name: "Synthetic Free" },
  { provider: "synthetic", id: "durable-endpoint", name: "Synthetic Durable" },
  { provider: "synthetic", id: "outside-endpoint", name: "Synthetic Main" },
];

try {
  const pi = fakePi();
  registerSwarmExtension(pi);
  const ctx = context(available);
  ctx.model = available[2];
  ctx.thinkingLevel = "xhigh";
  pi.handlers.get("session_start")[0]({}, ctx);

  const coordinator = pi.handlers.get("before_agent_start")[0]({ systemPrompt: "base" });
  assert.match(coordinator.systemPrompt, /free-research/);
  assert.match(coordinator.systemPrompt, /durable-coder/);
  assert.match(coordinator.systemPrompt, /primary/);
  assert.match(coordinator.systemPrompt, /\[free\]/);
  assert.doesNotMatch(coordinator.systemPrompt, /synthetic\/free-endpoint|synthetic\/durable-endpoint|synthetic\/outside-endpoint/, "coordinator must see aliases, not private or primary targets");

  const seen = [];
  const originalRun = SwarmAgentRuntime.prototype.run;
  SwarmAgentRuntime.prototype.run = async (input) => {
    seen.push(input);
    return {
      workerId: input.workerId, agentId: input.agentId, resumable: false, status: "completed",
      finishedAt: 2, durationMs: 1, turns: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      output: "ok", profile: "coder", toolCalls: {},
    };
  };
  try {
    const explicit = await pi.toolDefs[0].execute("pool-explicit", {
      description: "research",
      model: "free-research",
      items: ["one", "two"],
    }, undefined, undefined, ctx);
    assert.deepEqual(seen.slice(0, 2).map((input) => input.model), ["synthetic/free-endpoint", "synthetic/free-endpoint"]);
    assert.ok(seen.slice(0, 2).every((input) => input.thinkingLevel === "medium"));
    assert.deepEqual(explicit.details.workers.map((worker) => worker.model), ["free-research", "free-research"]);
    assert.ok(explicit.details.workers.every((worker) => worker.thinking === "medium"));

    const defaulted = await pi.toolDefs[0].execute("pool-default", {
      description: "coding",
      items: ["one"],
    }, undefined, undefined, ctx);
    assert.equal(seen.at(-1).model, "synthetic/durable-endpoint");
    assert.equal(seen.at(-1).thinkingLevel, "medium");
    assert.equal(defaulted.details.workers[0].model, "durable-coder");
    assert.equal(defaulted.details.workers[0].thinking, "medium");

    const primary = await pi.toolDefs[0].execute("pool-primary", {
      description: "hard reasoning",
      model: "primary",
      items: ["one"],
    }, undefined, undefined, ctx);
    assert.equal(seen.at(-1).model, "synthetic/outside-endpoint");
    assert.equal(seen.at(-1).thinkingLevel, "xhigh");
    assert.equal(seen.at(-1).modelDefinition, available[2]);
    assert.equal(primary.details.workers[0].model, "primary");
    assert.equal(primary.details.workers[0].thinking, "xhigh");
    assert.doesNotMatch(JSON.stringify(primary.details), /synthetic\/outside-endpoint/);

    await assert.rejects(
      pi.toolDefs[0].execute("pool-outside", { description: "outside", model: "outside", items: ["one"] }, undefined, undefined, ctx),
      /not whitelisted/,
    );
    assert.equal(seen.length, 4, "non-whitelisted aliases must fail before worker creation");
  } finally {
    SwarmAgentRuntime.prototype.run = originalRun;
  }

  process.env.PI_SWARM_MODEL_POOL = "off";
  const legacyPi = fakePi();
  registerSwarmExtension(legacyPi);
  const legacyCtx = context(available);
  legacyPi.handlers.get("session_start")[0]({}, legacyCtx);
  await assert.rejects(
    legacyPi.toolDefs[0].execute("legacy-alias", { description: "x", model: "free-research", items: ["one"] }, undefined, undefined, legacyCtx),
    /require a configured local model pool/,
  );
} finally {
  if (previous === undefined) delete process.env.PI_SWARM_MODEL_POOL;
  else process.env.PI_SWARM_MODEL_POOL = previous;
  rmSync(dir, { recursive: true, force: true });
}

console.log("SWARM_MODEL_POOL_REGISTRATION_OK");
