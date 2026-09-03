import assert from "node:assert/strict";
import { getSwarmIntegration } from "../src/public-api.ts";

const integration = getSwarmIntegration();
for (const run of integration.snapshot().runs) integration.removeRun(run.runId);
const badListener = integration.subscribe(() => { throw new Error("observer failure"); });
assert.doesNotThrow(() => integration.setEnabled(false), "optional observers must not break producers");
badListener();
let isolatedEnabled;
const mutatingListener = integration.subscribe((event) => { event.snapshot.enabled = false; });
const isolatedListener = integration.subscribe((event) => { isolatedEnabled = event.snapshot.enabled; });
integration.setEnabled(true);
assert.equal(isolatedEnabled, true, "each observer must receive an isolated event clone");
mutatingListener(); isolatedListener();
const events = [];
const unsubscribe = integration.subscribe((event) => events.push(event));
integration.setEnabled(true);
integration.updateRun({
  runId: "run-1",
  description: "safe token=description-secret C:\\private\\description",
  status: "running",
  createdAt: 1,
  requestedConcurrency: 2,
  activeCapacity: 2,
  workers: [{
    workerId: "worker-1", agentId: "agent-1", resumed: false, resumable: true, index: 0, item: "one token=item-secret /repo/private/item", status: "blocked", failureKind: "model_unavailable", attempt: 1,
    turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", profile: "coder", output: "private transcript", error: "private error",
    cwd: "C:/private/project", sessionPath: "C:/private/session.json", rawFailure: "SECRET raw provider payload",
    toolCalls: { read: 14, bash: 3, edit: 2, write: 2_000_000, report_blocked: 1, evil: 99, negative: -1 },
    currentTool: "evil", currentTarget: "../secret.txt", lastActivityAt: 12,
    touchedFiles: ["src/a.ts", "src/a.ts", "../secret", "/absolute", "C:/private", "src/b.ts"],
    overlapFiles: ["src/b.ts"], question: "Need C:\\private\\repo token=abc Authorization: Bearer xyz \\\\server\\share https://user:pass@example.test/x and /repo/private/file.ts", transcript: "secret transcript",
  }],
});
const snapshot = integration.snapshot();
assert.equal(snapshot.enabled, true);
assert.equal(snapshot.apiVersion, 2);
assert.equal(snapshot.runs.length, 1);
assert.equal(snapshot.runs[0].workers[0].workerId, "worker-1");
assert.doesNotMatch(snapshot.runs[0].description, /description-secret|C:\\private/);
assert.doesNotMatch(snapshot.runs[0].workers[0].item, /item-secret|\/repo\/private/);
assert.equal(snapshot.runs[0].workers[0].output, undefined);
assert.equal(snapshot.runs[0].workers[0].error, undefined);
assert.equal(snapshot.runs[0].workers[0].rawFailure, undefined);
assert.equal(snapshot.runs[0].workers[0].status, "blocked");
assert.equal(snapshot.runs[0].workers[0].failureKind, "model_unavailable");
assert.deepEqual(snapshot.runs[0].workers[0].toolCalls, { read: 14, bash: 3, edit: 2, write: 1_000_000, report_blocked: 1 });
assert.equal(snapshot.runs[0].workers[0].currentTool, undefined);
assert.equal(snapshot.runs[0].workers[0].currentTarget, undefined);
assert.equal(snapshot.runs[0].workers[0].lastActivityAt, 12);
assert.deepEqual(snapshot.runs[0].workers[0].touchedFiles, ["src/a.ts", "src/b.ts"]);
assert.deepEqual(snapshot.runs[0].workers[0].overlapFiles, ["src/b.ts"]);
assert.doesNotMatch(snapshot.runs[0].workers[0].question, /C:\\private|\/repo\/private|abc|xyz|server|user:pass/);
assert.equal(snapshot.runs[0].workers[0].cwd, undefined);
assert.equal(snapshot.runs[0].workers[0].sessionPath, undefined);
assert.equal(snapshot.profile, "coder");
assert.equal(snapshot.runs[0].workers[0].profile, "coder");
assert.equal(snapshot.runs[0].workers[0].transcript, undefined);
snapshot.runs[0].workers[0].status = "failed";
assert.equal(integration.snapshot().runs[0].workers[0].status, "blocked", "snapshots must be defensive clones");
let cancelled = 0;
integration.setRunController("run-1", () => cancelled++);
assert.equal(integration.cancelRun("run-1"), true);
assert.equal(cancelled, 1);
integration.removeRun("run-1");
assert.equal(integration.cancelRun("run-1"), false);
// v1-shaped callers may omit every v2 telemetry field.
integration.updateRun({
  runId: "old", description: "old", status: "blocked", createdAt: 2,
  requestedConcurrency: 1, activeCapacity: 1,
  workers: [{ workerId: "w", agentId: "a", resumed: false, resumable: false, index: 0, item: "old", status: "queued", failureKind: "not-a-real-kind", attempt: 0,
    turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0,
    model: "m".repeat(300), thinking: "low".repeat(30), currentTarget: "src/ok.ts", question: "token=x ".repeat(100) }],
});
assert.doesNotThrow(() => integration.snapshot());
assert.equal(integration.snapshot().runs.at(-1).workers[0].toolCalls, undefined);
assert.equal(integration.snapshot().runs.at(-1).workers[0].failureKind, undefined);
assert.equal(integration.snapshot().runs.at(-1).workers[0].currentTarget, "src/ok.ts");
assert.equal(integration.snapshot().runs.at(-1).workers[0].question.length, 500);
assert.doesNotMatch(integration.snapshot().runs.at(-1).workers[0].question, /token=x/);
assert.equal(integration.snapshot().runs.at(-1).workers[0].model.length, 200);
assert.equal(integration.snapshot().runs.at(-1).workers[0].thinking.length, 50);
assert.deepEqual(events.map((event) => event.type), ["mode", "run", "run_removed", "run"]);
unsubscribe();
console.log("SWARM_PUBLIC_API_TEST_OK");
