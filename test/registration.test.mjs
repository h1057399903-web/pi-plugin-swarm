import assert from "node:assert/strict";
import registerSwarmExtension, { resolveSwarmConcurrency } from "../src/index.ts";

assert.equal(resolveSwarmConcurrency(1), 1);
assert.equal(resolveSwarmConcurrency(8), 8);
assert.equal(resolveSwarmConcurrency(128), 16);
assert.equal(resolveSwarmConcurrency(8, 3), 3);

function fakePi() {
  const handlers = new Map(); const commands = []; const tools = [];
  return {
    handlers, commands, tools,
    on(type, handler) { const list = handlers.get(type) || []; list.push(handler); handlers.set(type, list); },
    registerCommand(name) { commands.push(name); },
    registerTool(tool) { tools.push(tool.name); },
    appendEntry() {}, sendUserMessage() {},
  };
}

const first = fakePi();
registerSwarmExtension(first);
assert.deepEqual(first.commands, ["swarm"]);
assert.deepEqual(first.tools, ["swarm"]);

// Pi owns extension lifecycle and invokes the standalone package once per load.
const reloaded = fakePi();
registerSwarmExtension(reloaded);
assert.deepEqual(reloaded.commands, ["swarm"]);
assert.deepEqual(reloaded.tools, ["swarm"]);
console.log("SWARM_RELOAD_REGISTRATION_OK");
