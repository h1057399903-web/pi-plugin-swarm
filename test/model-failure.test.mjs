import assert from "node:assert/strict";
import { classifyWorkerFailure } from "../src/model-failure.ts";
import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";

function error(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

assert.deepEqual(classifyWorkerFailure(error("too many requests", { status: 429 })), {
  kind: "rate_limited",
  safeMessage: "Provider rate limit.",
});
assert.deepEqual(classifyWorkerFailure(error("provider code only", { code: "429" })), {
  kind: "rate_limited",
  safeMessage: "Provider rate limit.",
});
assert.deepEqual(classifyWorkerFailure(error("Monthly usage limit reached", { status: 429 })), {
  kind: "quota_exhausted",
  safeMessage: "Model quota exhausted.",
});
assert.deepEqual(classifyWorkerFailure(error("model is not available", { status: 404 })), {
  kind: "model_unavailable",
  safeMessage: "Worker model is unavailable.",
});
assert.deepEqual(classifyWorkerFailure(error("invalid api key", { status: 401 })), {
  kind: "auth_failed",
  safeMessage: "Model authentication unavailable.",
});
assert.deepEqual(classifyWorkerFailure(error("service unavailable", { status: 503 })), {
  kind: "provider_transient",
  safeMessage: "Provider temporarily unavailable.",
});
assert.deepEqual(classifyWorkerFailure(error("context_length_exceeded")), {
  kind: "context_incompatible",
  safeMessage: "Worker context is incompatible.",
});
assert.deepEqual(classifyWorkerFailure(error("Worker timed out.")), {
  kind: "task_failed",
  safeMessage: "Worker timed out.",
});
assert.deepEqual(classifyWorkerFailure(error("SECRET arbitrary provider payload")), {
  kind: "task_failed",
  safeMessage: "Worker failed.",
});

const syntheticModel = { provider: "synthetic", id: "test-model" };
function runtimeFor(thrown) {
  return new SwarmAgentRuntime({
    runtimeFactory: async () => ({ getModel: () => syntheticModel }),
    sessionManagerFactory: (cwd) => ({ cwd }),
    resourceLoaderFactory: () => ({ reload: async () => {} }),
    sessionFactory: async () => ({
      session: {
        messages: [],
        subscribe() { return () => {}; },
        async prompt() { throw thrown; },
        dispose() {},
      },
    }),
  });
}

const unavailable = await runtimeFor(error("SECRET model body", { status: 404 })).run({
  workerId: "model-unavailable",
  model: "synthetic/test-model",
  prompt: "x",
  cwd: "/tmp",
});
assert.equal(unavailable.status, "failed");
assert.equal(unavailable.failureKind, "model_unavailable");
assert.equal(unavailable.error, "Worker model is unavailable.");
assert.doesNotMatch(unavailable.error, /SECRET/);

const quota = await runtimeFor(error("SECRET Monthly usage limit reached", { status: 429 })).run({
  workerId: "quota",
  model: "synthetic/test-model",
  prompt: "x",
  cwd: "/tmp",
});
assert.equal(quota.status, "failed", "quota exhaustion must not enter the 429 retry loop");
assert.equal(quota.failureKind, "quota_exhausted");
assert.equal(quota.error, "Model quota exhausted.");

const rate = await runtimeFor(error("SECRET too many requests", { status: 429 })).run({
  workerId: "rate",
  model: "synthetic/test-model",
  prompt: "x",
  cwd: "/tmp",
});
assert.equal(rate.status, "rate_limited");
assert.equal(rate.failureKind, "rate_limited");
assert.equal(rate.error, "Provider rate limit.");

console.log("SWARM_MODEL_FAILURE_TEST_OK");
