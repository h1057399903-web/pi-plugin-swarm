import assert from "node:assert/strict";
import registerSwarmExtension, { countSwarmWorkers, renderSwarmTaskPrompt, resumeAgentIdsHint, resolveSwarmConcurrency, validateUniqueRenderedPrompts } from "../src/index.ts";

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

function fakePi() {
  const handlers = new Map(); const commands = []; const tools = []; const toolDefs = [];
  return {
    handlers, commands, tools, toolDefs,
    on(type, handler) { const list = handlers.get(type) || []; list.push(handler); handlers.set(type, list); },
    registerCommand(name) { commands.push(name); },
    registerTool(tool) { tools.push(tool.name); toolDefs.push(tool); },
    appendEntry() {}, sendUserMessage() {},
  };
}

const first = fakePi();
registerSwarmExtension(first);
assert.deepEqual(first.commands, ["swarm"]);
assert.deepEqual(first.tools, ["swarm"]);
await assert.rejects(
  first.toolDefs[0].execute("duplicate", {
    description: "duplicates",
    tasks: [{ item: "same", subagent_type: "explore" }, { item: "same", subagent_type: "coder" }],
    promptTemplate: "Inspect {{item}}",
  }, undefined, undefined, {}),
  /Duplicate rendered prompt/,
  "duplicates must fail before execute reads session context or starts a worker",
);

// Pi owns extension lifecycle and invokes the standalone package once per load.
const reloaded = fakePi();
registerSwarmExtension(reloaded);
assert.deepEqual(reloaded.commands, ["swarm"]);
assert.deepEqual(reloaded.tools, ["swarm"]);
console.log("SWARM_RELOAD_REGISTRATION_OK");
