import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";
import { SwarmBatch } from "../src/features/swarm-batch.ts";

const runtime = new SwarmAgentRuntime();
const controller = new AbortController();
let active = 0;
let peakActive = 0;
let cleaned = 0;
const startedAt = Date.now();
const batch = new SwarmBatch(Array.from({ length: 16 }, (_, i) => i), async (i, context) => {
  active++;
  peakActive = Math.max(peakActive, active);
  const stop = () => runtime.abort(`abort16-${i}`);
  context.signal.addEventListener("abort", stop, { once: true });
  try {
    return await runtime.run({ workerId: `abort16-${i}`, cwd: "/tmp", timeoutMs: 120_000, prompt: "Use bash to run sleep 60, then reply DONE." });
  } finally {
    context.signal.removeEventListener("abort", stop);
    active--;
    cleaned++;
  }
}, { maxConcurrency: 16, initialLaunchLimit: 5, launchStaggerMs: 700, signal: controller.signal });

const promise = batch.run();
setTimeout(() => controller.abort(new Error("acceptance abort")), 8_500);
const results = await promise;
const summary = { peakActive, active, cleaned, wallMs: Date.now() - startedAt, statuses: results.map((result) => result.status) };
console.log(JSON.stringify(summary, null, 2));
if (peakActive !== 16 || active !== 0 || cleaned !== 16 || results.some((result) => result.status !== "aborted") || summary.wallMs > 30_000) process.exitCode = 1;
