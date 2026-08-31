import assert from "node:assert/strict";
import { getSwarmIntegration } from "../src/public-api.ts";

const integration = getSwarmIntegration();
for (const run of integration.snapshot().runs) integration.removeRun(run.runId);
const badListener = integration.subscribe(() => { throw new Error("observer failure"); });
assert.doesNotThrow(() => integration.setEnabled(false), "optional observers must not break producers");
badListener();
const events = [];
const unsubscribe = integration.subscribe((event) => events.push(event));
integration.setEnabled(true);
integration.updateRun({
  runId: "run-1",
  description: "safe",
  status: "running",
  createdAt: 1,
  requestedConcurrency: 2,
  activeCapacity: 2,
  workers: [{
    workerId: "worker-1", agentId: "agent-1", resumed: false, resumable: true, index: 0, item: "one", status: "running", attempt: 1,
    turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", output: "private transcript", error: "private error",
  }],
});
const snapshot = integration.snapshot();
assert.equal(snapshot.enabled, true);
assert.equal(snapshot.runs.length, 1);
assert.equal(snapshot.runs[0].workers[0].workerId, "worker-1");
assert.equal(snapshot.runs[0].workers[0].output, undefined);
assert.equal(snapshot.runs[0].workers[0].error, undefined);
snapshot.runs[0].workers[0].status = "failed";
assert.equal(integration.snapshot().runs[0].workers[0].status, "running", "snapshots must be defensive clones");
let cancelled = 0;
integration.setRunController("run-1", () => cancelled++);
assert.equal(integration.cancelRun("run-1"), true);
assert.equal(cancelled, 1);
integration.removeRun("run-1");
assert.equal(integration.cancelRun("run-1"), false);
assert.deepEqual(events.map((event) => event.type), ["mode", "run", "run_removed"]);
unsubscribe();
console.log("SWARM_PUBLIC_API_TEST_OK");
