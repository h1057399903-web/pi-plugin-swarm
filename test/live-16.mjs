import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";
import { SwarmBatch } from "../src/features/swarm-batch.ts";

const count = 16;
const runtime = new SwarmAgentRuntime();
let active = 0;
let peakActive = 0;
let runtimeProgressEvents = 0;
let batchProgressEvents = 0;
const started = Array.from({ length: count });
const wallStart = Date.now();
const batch = new SwarmBatch(Array.from({ length: count }, (_, i) => i), async (i) => {
  active++;
  peakActive = Math.max(peakActive, active);
  started[i] = Date.now() - wallStart;
  try {
    return await runtime.run({
      workerId: `live16-${i + 1}`,
      cwd: "/tmp",
      timeoutMs: 180_000,
      prompt: `Concurrency acceptance worker ${i + 1}. Use bash once to run: sleep 12. Then reply exactly SWARM16_OK_${i + 1} and nothing else.`,
    }, () => { runtimeProgressEvents++; });
  } finally {
    active--;
  }
}, { maxConcurrency: 16, initialLaunchLimit: 5, launchStaggerMs: 700, maxRetries: 0, timeoutMs: 190_000, onProgress: () => { batchProgressEvents++; } });

const results = await batch.run();
const workers = results.map((result, index) => ({ index: index + 1, startedMs: started[index], status: result.value?.status, output: result.value?.output }));
const summary = { peakActive, wallMs: Date.now() - wallStart, eventCount: runtimeProgressEvents + batchProgressEvents, runtimeProgressEvents, batchProgressEvents, completed: workers.filter((worker) => worker.status === "completed").length, exact: workers.filter((worker) => worker.output === `SWARM16_OK_${worker.index}`).length, workers };
console.log(JSON.stringify(summary, null, 2));
if (summary.peakActive !== 16 || summary.completed !== 16 || summary.exact !== 16) process.exitCode = 1;
