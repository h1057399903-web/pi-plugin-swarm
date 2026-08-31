import assert from "node:assert/strict";
import { SwarmAgentRuntime, MAX_OUTPUT_BYTES } from "../src/swarm-agent-runtime.ts";

const model = {};
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

// final output is capped to 50 KiB
{
  const text = "x".repeat(MAX_OUTPUT_BYTES + 99);
  const result = await new SwarmAgentRuntime(seams(() => sessionFor(text))).run({ workerId: "cap", prompt: "x", cwd: "/tmp" });
  assert.equal(Buffer.byteLength(result.output), MAX_OUTPUT_BYTES);
}

console.log("SWARM_AGENT_RUNTIME_TEST_OK");
