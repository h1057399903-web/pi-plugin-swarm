import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SwarmAgentRuntime, MAX_OUTPUT_BYTES, isPathInside } from "../src/swarm-agent-runtime.ts";

// Containment is deterministic for both path syntaxes and does not use lexical prefixes.
assert.equal(isPathInside("/repo/work", "/repo"), true);
assert.equal(isPathInside("/repo-other", "/repo"), false);
assert.equal(isPathInside("C:\\repo\\work", "C:\\repo"), true);
assert.equal(isPathInside("C:\\repo-other", "C:\\repo"), false);

const model = {};
const ownerDirectory = (owner) => join("/test-agent", "swarm", "sessions", createHash("sha256").update(owner).digest("hex").slice(0, 32));
function seams(makeSession, extra = {}) {
  let runtimes = 0;
  return {
    runtimeFactory: async () => { runtimes++; return { getModel: () => model }; },
    sessionManagerFactory: (cwd) => ({ cwd }),
    resourceLoaderFactory: () => ({ reload: async () => {} }),
    realpathFactory: async (path) => path,
    sessionFactory: async (options) => ({ session: makeSession(options) }),
    ...extra,
    get runtimeCount() { return runtimes; },
  };
}
function sessionFor(text, delay = 0) {
  const listeners = new Set();
  const assistant = { role: "assistant", content: [{ type: "text", text }], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.1 } } };
  return {
    messages: [], subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async prompt() { listeners.forEach((f) => f({ type: "turn_start" })); await new Promise(r => setTimeout(r, delay)); this.messages.push(assistant); listeners.forEach((f) => f({ type: "message_end", message: assistant })); },
    dispose() { this.disposed = true; }, abort() { this.aborted = true; },
  };
}

// The parent cwd gate runs before runtime/session factories.
{
  let factories = 0;
  const result = await new SwarmAgentRuntime({
    runtimeFactory: async () => { factories++; return { getModel: () => model }; },
    realpathFactory: async (path) => path,
  }).run({ workerId: "outside", prompt: "x", cwd: "/repo-other", parentCwd: "/repo" });
  assert.equal(result.error, "Worker cwd is outside the parent working directory.");
  assert.equal(factories, 0);

  const relative = await new SwarmAgentRuntime(seams(() => sessionFor("relative"))).run({ workerId: "relative", prompt: "x", cwd: "child", parentCwd: "/repo" });
  assert.equal(relative.status, "completed");
  const symlink = await new SwarmAgentRuntime({
    runtimeFactory: async () => { factories++; return { getModel: () => model }; },
    realpathFactory: async (path) => path === "/repo/link" ? "/outside" : path,
  }).run({ workerId: "symlink", prompt: "x", cwd: "/repo/link", parentCwd: "/repo" });
  assert.equal(symlink.error, "Worker cwd is outside the parent working directory.");
}

// success, output, accounting, and cleanup
{
  let s;
  const r = new SwarmAgentRuntime(seams(() => (s = sessionFor("ok"))));
  const result = await r.run({ workerId: "one", prompt: "hello", cwd: "/tmp" });
  assert.equal(result.status, "completed"); assert.equal(result.output, "ok"); assert.equal(result.turns, 1);
  assert.equal(result.usage.input, 2); assert.equal(s.disposed, true);
}

// run completion waits for asynchronous session disposal.
{
  let releaseDispose;
  const disposeDone = new Promise((resolve) => { releaseDispose = resolve; });
  const s = sessionFor("disposed");
  s.dispose = () => disposeDone;
  const pending = new SwarmAgentRuntime(seams(() => s)).run({ workerId: "async-dispose", prompt: "x", cwd: "/tmp" });
  assert.equal(await Promise.race([pending.then(() => "resolved"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 10))]), "waiting");
  releaseDispose();
  assert.equal((await pending).status, "completed");
}

// concurrent workers share one runtime but get separate in-memory managers/sessions
{
  const managers = []; let sessions = 0;
  const seam = seams((o) => { sessions++; return sessionFor(String(o.sessionManager.cwd)); }, { sessionManagerFactory: (cwd) => { const m = { cwd }; managers.push(m); return m; } });
  const r = new SwarmAgentRuntime(seam);
  const [a, b] = await Promise.all([r.run({ workerId: "a", prompt: "a", cwd: "/a" }), r.run({ workerId: "b", prompt: "b", cwd: "/b" })]);
  assert.equal(seam.runtimeCount, 1); assert.equal(sessions, 2); assert.deepEqual(managers.map(x => x.cwd).sort(), ["/a", "/b"]); assert.notEqual(a.output, b.output);
}

// abort settles a hung prompt and disposes it
{
  let s;
  const r = new SwarmAgentRuntime(seams(() => { s = sessionFor("never"); s.prompt = () => new Promise(() => {}); return s; }));
  const p = r.run({ workerId: "abort", prompt: "x", cwd: "/tmp" });
  await new Promise(r => setTimeout(r, 0)); r.abort("abort");
  assert.equal((await p).status, "aborted"); assert.equal(s.disposed, true);
}

// rate-limit errors are classified and do not expose provider text
{
  const r = new SwarmAgentRuntime(seams(() => { const s = sessionFor(""); s.prompt = async () => { const e = new Error("SECRET response body"); e.status = 429; throw e; }; return s; }));
  const result = await r.run({ workerId: "rate", prompt: "x", cwd: "/tmp" });
  assert.equal(result.status, "rate_limited"); assert.equal(result.error, "Provider rate limit."); assert.doesNotMatch(result.error, /SECRET/);
}

// token progress is throttled so a 16-worker run cannot flood the parent TUI
{
  let now = 1_000;
  const s = sessionFor("");
  s.prompt = async function () {
    for (const listener of [...this._listeners]) for (let i = 0; i < 100; i++) listener({ type: "message_update", assistantMessageEvent: { delta: "x" } });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "x".repeat(100) }] });
  };
  s.subscribe = function (fn) { (this._listeners ??= new Set()).add(fn); return () => this._listeners.delete(fn); };
  const updates = [];
  const r = new SwarmAgentRuntime(seams(() => s, { now: () => now, progressThrottleMs: 250 }));
  const result = await r.run({ workerId: "throttle", prompt: "x", cwd: "/tmp" }, (progress) => updates.push(progress));
  assert.equal(result.output.length, 100);
  assert.equal(updates.filter((update) => update.output).length, 1);
}

// persistent sessions are owner-scoped, identify the worker, and dispose after each run
{
  const calls = []; const sessions = [];
  const manager = (id) => ({ getSessionId: () => id });
  const seam = seams((_o) => { const s = sessionFor("saved"); sessions.push(s); return s; }, {
    agentDirFactory: () => "/test-agent",
    sessionCreateFactory: (cwd, dir) => { calls.push(["create", cwd, dir]); return manager("agent-1"); },
  });
  const result = await new SwarmAgentRuntime(seam).run({ workerId: "worker", prompt: "x", cwd: "/work", ownerSessionId: "owner/one", persist: true });
  assert.equal(result.agentId, "agent-1"); assert.equal(result.resumable, true); assert.equal(sessions[0].disposed, true);
  assert.deepEqual(calls[0], ["create", "/work", ownerDirectory("owner/one")]);
}

// resume only opens a matching session from the requested owner directory
{
  const calls = []; let resumed;
  const seam = seams(() => (resumed = sessionFor("resumed")), {
    agentDirFactory: () => "/test-agent",
    sessionListFactory: async (dir) => { calls.push(["list", dir]); return [{ id: "agent-2", path: join(dir, "agent-2.jsonl") }]; },
    sessionOpenFactory: (path, dir, cwd) => { calls.push(["open", path, dir, cwd]); return { getSessionId: () => "agent-2" }; },
  });
  const result = await new SwarmAgentRuntime(seam).run({ workerId: "resume", agentId: "agent-2", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(result.output, "resumed"); assert.deepEqual(calls[1], ["open", join(ownerDirectory("owner"), "agent-2.jsonl"), ownerDirectory("owner"), "/work"]); assert.equal(resumed.disposed, true);
}

// the same persisted agent cannot be opened concurrently
{
  const seam = seams(() => sessionFor("ok", 20), {
    agentDirFactory: () => "/test-agent",
    sessionCreateFactory: () => ({ getSessionId: () => "agent-busy" }),
  });
  const runtime = new SwarmAgentRuntime(seam);
  const first = runtime.run({ workerId: "busy-1", agentId: "agent-busy", ownerSessionId: "owner", persist: true, prompt: "x", cwd: "/work" });
  await Promise.resolve();
  const second = await new SwarmAgentRuntime(seam).run({ workerId: "busy-2", agentId: "agent-busy", ownerSessionId: "owner", persist: true, prompt: "x", cwd: "/work" });
  assert.equal(second.status, "failed"); assert.equal(second.error, "Worker session is busy.");
  assert.equal((await first).status, "completed");
}

// wrong-owner and unavailable resume are rejected without exposing paths
{
  for (const list of [async () => [], async () => [{ id: "agent", path: "/other/agent.jsonl" }]]) {
    let created = false;
    const result = await new SwarmAgentRuntime(seams(() => { created = true; return sessionFor("no"); }, { agentDirFactory: () => "/test-agent", sessionListFactory: list })).run({ workerId: "bad", agentId: "agent", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
    assert.equal(result.status, "failed"); assert.equal(result.error, "Worker session is unavailable."); assert.equal(created, false);
  }
}

// canonical path checks reject a symlink-style escape from a lexical owner path
{
  const result = await new SwarmAgentRuntime(seams(() => sessionFor("no"), {
    agentDirFactory: () => "/test-agent",
    sessionListFactory: async (dir) => [{ id: "agent", path: join(dir, "agent.jsonl") }],
    realpathFactory: async (path) => path.endsWith("agent.jsonl") ? join("/outside", "agent.jsonl") : path,
  })).run({ workerId: "symlink", agentId: "agent", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(result.status, "failed"); assert.equal(result.error, "Worker session is unavailable.");
}

// fork accepts the trusted parent session as source but writes only inside the owner directory
{
  const calls = []; const source = "/parent-sessions/source.jsonl";
  const seam = seams(() => sessionFor("forked"), { agentDirFactory: () => "/test-agent", sessionForkFactory: (path, cwd, dir, agentId) => { calls.push([path, cwd, dir, agentId]); return { getSessionId: () => "forked-id" }; } });
  const result = await new SwarmAgentRuntime(seam).run({ workerId: "fork", agentId: "requested-id", ownerSessionId: "owner", persist: true, forkSessionFile: source, prompt: "x", cwd: "/work" });
  assert.equal(result.agentId, "requested-id"); assert.deepEqual(calls, [[source, "/work", ownerDirectory("owner"), "requested-id"]]);
}

// default remains in-memory even when an owner is supplied
{
  let persistent = false; let selected;
  const result = await new SwarmAgentRuntime(seams((o) => { selected = o.sessionManager; return sessionFor("memory"); }, { sessionCreateFactory: () => { persistent = true; } })).run({ workerId: "memory", ownerSessionId: "owner", prompt: "x", cwd: "/work" });
  assert.equal(result.resumable, false); assert.equal(result.output, "memory"); assert.deepEqual(selected, { cwd: "/work" }); assert.equal(persistent, false);
}

// final output is capped to 50 KiB
{
  const text = "x".repeat(MAX_OUTPUT_BYTES + 99);
  const result = await new SwarmAgentRuntime(seams(() => sessionFor(text))).run({ workerId: "cap", prompt: "x", cwd: "/tmp" });
  assert.equal(Buffer.byteLength(result.output), MAX_OUTPUT_BYTES);
}

// timeout covers runtime/session setup and does not leave a rejected promise unobserved
{
  const r = new SwarmAgentRuntime({ runtimeFactory: () => new Promise(() => {}) });
  const result = await r.run({ workerId: "setup-timeout", prompt: "x", cwd: "/tmp", timeoutMs: 10 });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Worker timed out.");
}

// a session created after timeout is immediately disposed instead of leaking
{
  let lateSession;
  const r = new SwarmAgentRuntime(seams(() => (lateSession = sessionFor("late")), {
    sessionFactory: async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { session: (lateSession = sessionFor("late")) };
    },
  }));
  const result = await r.run({ workerId: "late-session", prompt: "x", cwd: "/tmp", timeoutMs: 10 });
  assert.equal(result.status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateSession.disposed, true);
}

// profiles enforce the exact built-in tool allowlist and persist worker metadata
{
  const options = []; const entries = [];
  const seam = seams((o) => { options.push(o); return sessionFor("profiled"); }, {
    sessionCreateFactory: () => ({ appendCustomEntry: (type, data) => entries.push({ type, data }), getSessionId: () => "profiled" }),
  });
  await new SwarmAgentRuntime(seam).run({ workerId: "explore", profile: "explore", item: "inspect", prompt: "x", cwd: "/work", persist: true });
  await new SwarmAgentRuntime(seam).run({ workerId: "coder", profile: "coder", item: "change", prompt: "x", cwd: "/work", persist: false });
  assert.deepEqual(options.map((o) => o.tools), [["read"], ["read", "bash", "edit", "write"]]);
  assert.deepEqual(entries[0], { type: "pi-plugin-swarm.worker", data: { profile: "explore", item: "inspect" } });
}

// resume recovers metadata, and legacy sessions remain coder without escalation
{
  const options = []; let opened;
  const manager = (metadata) => ({ getEntries: () => metadata ? [{ type: "custom", customType: "pi-plugin-swarm.worker", data: metadata }] : [], getSessionId: () => "saved" });
  const seam = seams((o) => { options.push(o); return sessionFor("resumed"); }, {
    agentDirFactory: () => "/test-agent",
    sessionListFactory: async (dir) => [{ id: "saved", path: join(dir, "saved.jsonl") }],
    sessionOpenFactory: () => (opened = manager({ profile: "explore", item: "original" })),
  });
  const recovered = await new SwarmAgentRuntime(seam).run({ workerId: "recover", agentId: "saved", item: "replacement", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(recovered.profile, "explore"); assert.equal(recovered.item, "original"); assert.deepEqual(options[0].tools, ["read"]); assert.equal(opened !== undefined, true);

  const legacy = new SwarmAgentRuntime(seams((o) => { options.push(o); return sessionFor("legacy"); }, {
    agentDirFactory: () => "/test-agent", sessionListFactory: async (dir) => [{ id: "legacy", path: join(dir, "legacy.jsonl") }], sessionOpenFactory: () => manager(undefined),
  }));
  const old = await legacy.run({ workerId: "legacy", agentId: "legacy", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(old.profile, "coder"); assert.deepEqual(options.at(-1).tools, ["read", "bash", "edit", "write"]);

  const escalation = await new SwarmAgentRuntime(seams(() => sessionFor("must-not-run"), {
    agentDirFactory: () => "/test-agent", sessionListFactory: async (dir) => [{ id: "saved", path: join(dir, "saved.jsonl") }], sessionOpenFactory: () => manager({ profile: "explore", item: "original" }),
  })).run({ workerId: "escalate", agentId: "saved", profile: "coder", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(escalation.status, "failed"); assert.equal(escalation.error, "Worker profile mismatch.");
}

// failures before a persisted SessionManager exists must not advertise resume
{
  let created = false;
  const result = await new SwarmAgentRuntime({
    runtimeFactory: async () => ({ getModel: () => undefined }),
    sessionCreateFactory: () => { created = true; return {}; },
  }).run({ workerId: "no-session", agentId: "no-session", ownerSessionId: "owner", persist: true, prompt: "x", cwd: "/work" });
  assert.equal(result.status, "failed"); assert.equal(result.resumable, false); assert.equal(created, false);
}

console.log("SWARM_AGENT_RUNTIME_TEST_OK");
