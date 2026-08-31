import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SwarmAgentRuntime, MAX_OUTPUT_BYTES } from "../src/swarm-agent-runtime.ts";

const model = {};
const ownerDirectory = (owner) => `/test-agent/swarm/sessions/${createHash("sha256").update(owner).digest("hex").slice(0, 32)}`;
function seams(makeSession, extra = {}) {
  let runtimes = 0;
  return {
    runtimeFactory: async () => { runtimes++; return { getModel: () => model }; },
    sessionManagerFactory: (cwd) => ({ cwd }),
    resourceLoaderFactory: () => ({ reload: async () => {} }),
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

// success, output, accounting, and cleanup
{
  let s;
  const r = new SwarmAgentRuntime(seams(() => (s = sessionFor("ok"))));
  const result = await r.run({ workerId: "one", prompt: "hello", cwd: "/tmp" });
  assert.equal(result.status, "completed"); assert.equal(result.output, "ok"); assert.equal(result.turns, 1);
  assert.equal(result.usage.input, 2); assert.equal(s.disposed, true);
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
    sessionListFactory: async (dir) => { calls.push(["list", dir]); return [{ id: "agent-2", path: `${dir}/agent-2.jsonl` }]; },
    sessionOpenFactory: (path, dir, cwd) => { calls.push(["open", path, dir, cwd]); return { getSessionId: () => "agent-2" }; },
  });
  const result = await new SwarmAgentRuntime(seam).run({ workerId: "resume", agentId: "agent-2", ownerSessionId: "owner", persist: true, resume: true, prompt: "x", cwd: "/work" });
  assert.equal(result.output, "resumed"); assert.deepEqual(calls[1], ["open", `${ownerDirectory("owner")}/agent-2.jsonl`, ownerDirectory("owner"), "/work"]); assert.equal(resumed.disposed, true);
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
  const second = await runtime.run({ workerId: "busy-2", agentId: "agent-busy", ownerSessionId: "owner", persist: true, prompt: "x", cwd: "/work" });
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

console.log("SWARM_AGENT_RUNTIME_TEST_OK");
