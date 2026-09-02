import assert from "node:assert/strict";
import registerSwarmExtension, { countSwarmWorkers, listSelectableWorkerModels, renderSwarmTaskPrompt, resumeAgentIdsHint, resolveSwarmConcurrency, validateUniqueRenderedPrompts } from "../src/index.ts";
import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";

assert.equal(resolveSwarmConcurrency(1), 1);
assert.equal(resolveSwarmConcurrency(8), 8);
assert.equal(resolveSwarmConcurrency(128), 16);
assert.equal(resolveSwarmConcurrency(8, 3), 3);
assert.equal(countSwarmWorkers({ tasks: [1], items: [2, 3] }), 3);
assert.equal(countSwarmWorkers({ resume_agent_ids: { a: "x" }, resumeAgentIds: { a: "override", b: "y" } }), 2);
assert.equal(renderSwarmTaskPrompt({ item: "src/a", prompt: "Fix {{item}}" }), "Fix src/a");
assert.deepEqual(validateUniqueRenderedPrompts([{ item: "a" }, { item: "b" }], "Inspect {{item}}"), ["Inspect a", "Inspect b"]);
assert.throws(() => validateUniqueRenderedPrompts([{ item: "a" }, { item: "a" }], "Inspect {{item}}"), /Duplicate rendered prompt/);
assert.equal(resumeAgentIdsHint([{ agentId: "done", item: "a", status: "completed", resumable: true }]), "");
assert.match(resumeAgentIdsHint([{ agentId: "open", item: "b", status: "aborted", resumable: true }]), /resume_agent_ids/);
assert.deepEqual(listSelectableWorkerModels({
  model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
  scopedModels: [],
  modelRegistry: { getAvailable: () => [
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    { provider: "anthropic", id: "claude-sonnet", name: "duplicate" },
  ] },
}, "openai-codex/gpt-5.6-luna"), [
  { value: "openai-codex/gpt-5.6-sol", label: "gpt-5.6-sol [openai-codex] — Sol ✓" },
  { value: "openai-codex/gpt-5.6-luna", label: "gpt-5.6-luna [openai-codex] — Luna · swarm current" },
  { value: "anthropic/claude-sonnet", label: "claude-sonnet [anthropic] — Claude Sonnet" },
]);
assert.deepEqual(listSelectableWorkerModels({
  scopedModels: [{ model: { provider: "scoped", id: "only", name: "Scoped Only" } }],
  modelRegistry: { getAvailable: () => [{ provider: "ignored", id: "model" }] },
}), [{ value: "scoped/only", label: "only [scoped] — Scoped Only" }]);

function fakePi() {
  const handlers = new Map(); const commands = []; const commandDefs = []; const tools = []; const toolDefs = []; const entries = [];
  return {
    handlers, commands, commandDefs, tools, toolDefs, entries,
    on(type, handler) { const list = handlers.get(type) || []; list.push(handler); handlers.set(type, list); },
    registerCommand(name, definition) { commands.push(name); commandDefs.push(definition); },
    registerTool(tool) { tools.push(tool.name); toolDefs.push(tool); },
    appendEntry(type, data) { entries.push({ type, data }); }, sendUserMessage() {},
  };
}
const ui = { setStatus() {}, notify() {} };
function fakeCommandContext({ available = [], scopedModels = [], model, choice, hasUI = true } = {}) {
  const notifications = []; const selections = [];
  return {
    hasUI,
    model,
    scopedModels,
    modelRegistry: {
      getAvailable: () => available,
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
    sessionManager: { getSessionId: () => "owner", getSessionFile: () => undefined },
    cwd: process.cwd(),
    notifications,
    selections,
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
      async select(title, options) { selections.push({ title, options }); return choice; },
    },
  };
}

const first = fakePi();
registerSwarmExtension(first);
assert.deepEqual(first.commands, ["swarm"]);
assert.deepEqual(first.tools, ["swarm"]);
assert.deepEqual(
  first.commandDefs[0].getArgumentCompletions(""),
  [
    { value: "on", label: "on", description: "Enable Swarm mode" },
    { value: "off", label: "off", description: "Disable Swarm mode" },
    { value: "status", label: "status", description: "Show Swarm status" },
    { value: "model", label: "model", description: "Choose the worker model" },
    { value: "cancel ", label: "cancel <run-id>", description: "Cancel an active Swarm run" },
  ],
);
assert.deepEqual(first.commandDefs[0].getArgumentCompletions("st"), [
  { value: "status", label: "status", description: "Show Swarm status" },
]);
assert.deepEqual(first.commandDefs[0].getArgumentCompletions("ST"), [
  { value: "status", label: "status", description: "Show Swarm status" },
]);
assert.deepEqual(first.commandDefs[0].getArgumentCompletions("mo"), [
  { value: "model", label: "model", description: "Choose the worker model" },
]);
assert.equal(first.commandDefs[0].getArgumentCompletions("unknown"), null);
const disabled = await first.toolDefs[0].execute("disabled", { description: "must not start", items: ["x"] }, undefined, undefined, {});
assert.equal(disabled.isError, true);
assert.match(disabled.content[0].text, /disabled/);
await first.commandDefs[0].handler("on", { ui });
await assert.rejects(
  first.toolDefs[0].execute("duplicate", {
    description: "duplicates",
    tasks: [{ item: "same", subagent_type: "explore" }, { item: "same", subagent_type: "coder" }],
    promptTemplate: "Inspect {{item}}",
  }, undefined, undefined, {}),
  /Duplicate rendered prompt/,
  "duplicates must fail before execute reads session context or starts a worker",
);
await first.commandDefs[0].handler("off", { ui });
assert.equal((await first.toolDefs[0].execute("disabled-again", { description: "x", items: ["x"] }, undefined, undefined, {})).isError, true);

// Worker model selection is catalog-backed, picker-driven, and session-persisted.
const selectable = fakePi();
registerSwarmExtension(selectable);
const availableModels = [
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
];
const pickerContext = fakeCommandContext({
  available: availableModels,
  model: availableModels[2],
  choice: "claude-sonnet [anthropic] — Claude Sonnet",
});
const selectedProviderConfig = { baseUrl: "https://example.invalid", api: "anthropic-messages" };
pickerContext.modelRegistry.getRegisteredProviderConfig = (provider) => provider === "anthropic" ? selectedProviderConfig : undefined;
await selectable.commandDefs[0].handler("model", pickerContext);
assert.deepEqual(pickerContext.selections[0].options, [
  "gpt-5.6-sol [openai-codex] — Sol ✓",
  "gpt-5.6-luna [openai-codex] — Luna · swarm current",
  "claude-sonnet [anthropic] — Claude Sonnet",
]);
assert.deepEqual(selectable.entries.at(-1), {
  type: "pi-swarm-state",
  data: { enabled: false, workerModel: "anthropic/claude-sonnet" },
});
assert.match(pickerContext.notifications.at(-1).message, /anthropic\/claude-sonnet/);

const rejectedContext = fakeCommandContext({ available: availableModels });
await selectable.commandDefs[0].handler("model unknown/model", rejectedContext);
assert.equal(selectable.entries.length, 1);
assert.equal(rejectedContext.notifications.at(-1).level, "warning");

const noUiContext = fakeCommandContext({ available: availableModels, hasUI: false });
await selectable.commandDefs[0].handler("model", noUiContext);
assert.equal(noUiContext.selections.length, 0);
assert.match(noUiContext.notifications.at(-1).message, /provider\/model/);

// Each run snapshots the selected model and passes it to every worker.
await selectable.commandDefs[0].handler("on", pickerContext);
const selectedInputs = [];
const originalSelectableRun = SwarmAgentRuntime.prototype.run;
SwarmAgentRuntime.prototype.run = async (input) => {
  selectedInputs.push(input);
  return {
    workerId: input.workerId, agentId: input.agentId, resumable: false, status: "completed",
    finishedAt: 2, durationMs: 1, turns: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    output: "ok", profile: "coder", toolCalls: {},
  };
};
try {
  const result = await selectable.toolDefs[0].execute("selected", {
    description: "selected model",
    items: ["one", "two"],
  }, undefined, undefined, pickerContext);
  assert.deepEqual(selectedInputs.map((input) => input.model), ["anthropic/claude-sonnet", "anthropic/claude-sonnet"]);
  assert.ok(selectedInputs.every((input) => input.modelDefinition === availableModels[1]));
  assert.ok(selectedInputs.every((input) => input.providerRegistration.config === selectedProviderConfig));
  assert.deepEqual(result.details.workers.map((worker) => worker.model), ["anthropic/claude-sonnet", "anthropic/claude-sonnet"]);

  pickerContext.modelRegistry.getAvailable = () => [availableModels[0]];
  await assert.rejects(
    selectable.toolDefs[0].execute("stale-selected", { description: "stale", items: ["one"] }, undefined, undefined, pickerContext),
    /not available in this Pi session/,
  );
  assert.equal(selectedInputs.length, 2, "an unavailable saved model must fail before worker creation");
} finally {
  SwarmAgentRuntime.prototype.run = originalSelectableRun;
}

// Pi owns extension lifecycle and restores the persisted gate and model on reload.
const reloaded = fakePi();
registerSwarmExtension(reloaded);
assert.deepEqual(reloaded.commands, ["swarm"]);
assert.deepEqual(reloaded.tools, ["swarm"]);
const sessionStart = reloaded.handlers.get("session_start")[0];
sessionStart({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-swarm-state", data: { enabled: true, workerModel: "anthropic/claude-sonnet" } }] }, ui, scopedModels: [], modelRegistry: { getAvailable: () => availableModels } });
await assert.rejects(
  reloaded.toolDefs[0].execute("restored", { description: "duplicates", items: ["same", "same"] }, undefined, undefined, {}),
  /Duplicate rendered prompt/,
);
sessionStart({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-swarm-state", data: { enabled: false } }] }, ui, scopedModels: [], modelRegistry: { getAvailable: () => availableModels } });
assert.equal((await reloaded.toolDefs[0].execute("restored-off", { description: "x", items: ["x"] }, undefined, undefined, {})).isError, true);

// Final tool output and persisted run state must use the redacted public question.
const blockedPi = fakePi();
registerSwarmExtension(blockedPi);
await blockedPi.commandDefs[0].handler("on", { ui });
const originalRun = SwarmAgentRuntime.prototype.run;
const rawQuestion = "Need token=abc at C:\\private\\repo ".repeat(30);
SwarmAgentRuntime.prototype.run = async (input) => ({
  workerId: input.workerId, agentId: input.agentId, resumable: false, status: "blocked",
  finishedAt: 2, durationMs: 1, turns: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  output: "", profile: "coder", toolCalls: { report_blocked: 1 }, question: rawQuestion,
});
try {
  const result = await blockedPi.toolDefs[0].execute("blocked", {
    description: "blocked token=descsecret /private/description",
    items: ["one token=itemsecret C:\\private\\item"],
  }, undefined, undefined, {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "owner", getSessionFile: () => undefined },
  });
  assert.match(result.content[0].text, /Question:/);
  assert.doesNotMatch(result.content[0].text, /abc|itemsecret|C:\\private/);
  const persistedRun = blockedPi.entries.at(-1).data;
  assert.doesNotMatch(persistedRun.description, /descsecret|\/private\/description/);
  assert.doesNotMatch(persistedRun.workers[0].item, /itemsecret|C:\\private/);
  assert.doesNotMatch(persistedRun.workers[0].question, /abc|C:\\private/);
  assert.ok(persistedRun.workers[0].question.length <= 500);
} finally {
  SwarmAgentRuntime.prototype.run = originalRun;
}
console.log("SWARM_RELOAD_REGISTRATION_OK");
