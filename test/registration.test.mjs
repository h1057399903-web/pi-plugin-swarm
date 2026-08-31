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

// A long-running Pi may retain the legacy boolean marker from v0.3.0.
globalThis[Symbol.for("pi-plugin-swarm.extension.registered.v2")] = true;
const first = fakePi();
registerSwarmExtension(first);
registerSwarmExtension(first);
assert.deepEqual(first.commands, ["swarm"]);
assert.deepEqual(first.tools, ["swarm"]);
for (const handler of first.handlers.get("session_shutdown") || []) handler({ reason: "reload" });

const reloaded = fakePi();
registerSwarmExtension(reloaded);
assert.deepEqual(reloaded.commands, ["swarm"]);
assert.deepEqual(reloaded.tools, ["swarm"]);
for (const handler of reloaded.handlers.get("session_shutdown") || []) handler({ reason: "quit" });
console.log("SWARM_RELOAD_REGISTRATION_OK");
