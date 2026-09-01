import assert from "node:assert/strict";
import { SwarmBatch } from "../src/features/swarm-batch.ts";

class FakeClock {
  nowValue = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.nowValue;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowValue + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async tick(ms) {
    const end = this.nowValue + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowValue = due[1].at;
      due[1].callback();
      await Promise.resolve();
    }
    this.nowValue = end;
    await Promise.resolve();
  }
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

// Stable order and a hard concurrency ceiling.
{
  const clock = new FakeClock();
  let active = 0;
  let peak = 0;
  const batch = new SwarmBatch(Array.from({ length: 16 }, (_, i) => i), async (task) => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return task * 2;
  }, { maxConcurrency: 3, initialLaunchLimit: 5, launchStaggerMs: 0, clock });
  const results = await batch.run();
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => r.value), Array.from({ length: 16 }, (_, i) => i * 2));
  assert.ok(results.every((r) => r.status === "completed"));
}

// Initial burst is capped, and subsequent launches are staggered.
{
  const clock = new FakeClock();
  const starts = [];
  const pending = new Map();
  const promise = new SwarmBatch([0, 1, 2, 3, 4, 5], (task) => {
    starts.push([task, clock.now()]);
    return new Promise((resolve) => pending.set(task, resolve));
  }, { maxConcurrency: 6, initialLaunchLimit: 5, launchStaggerMs: 700, clock }).run();
  await flush();
  assert.equal(starts.length, 5);
  pending.get(0)(0);
  await flush();
  assert.equal(starts.length, 5);
  await clock.tick(699);
  assert.equal(starts.length, 5);
  await clock.tick(1);
  assert.equal(starts.length, 6);
  for (const resolve of pending.values()) resolve(1);
  await promise;
}

// Rate limits requeue with exponential delay, shrink capacity, then recover.
{
  const clock = new FakeClock();
  const attempts = [];
  const resultPromise = new SwarmBatch(["a", "b"], (task, context) => {
    attempts.push([task, context.attempt, clock.now()]);
    if (task === "a" && context.attempt === 1) throw new Error("429");
    return task;
  }, { maxConcurrency: 2, initialLaunchLimit: 2, launchStaggerMs: 0, retryBaseMs: 3_000, capacityRecoveryMs: 10_000, maxRetries: 2, clock,
    isRateLimitedError: (error) => error.message === "429" }).run();
  await flush();
  assert.equal(attempts.length, 2);
  await clock.tick(2999);
  assert.equal(attempts.filter((x) => x[1] === 2).length, 0);
  await clock.tick(1);
  const results = await resultPromise;
  assert.deepEqual(results.map((r) => r.status), ["completed", "completed"]);
  assert.equal(attempts.find((x) => x[0] === "a" && x[1] === 2)[2], 3000);
}

// Rate-limited retries are observable as suspended and wake exactly at readyAt.
{
  const clock = new FakeClock();
  const attempts = [];
  const snapshots = []; const queuedCounts = [];
  const resultPromise = new SwarmBatch(["retry"], (_task, context) => {
    attempts.push([context.attempt, clock.now()]);
    if (context.attempt === 1) throw new Error("429");
    return "ok";
  }, {
    maxConcurrency: 1,
    initialLaunchLimit: 1,
    launchStaggerMs: 0,
    retryBaseMs: 100,
    clock,
    onProgress: (progress) => { snapshots.push(progress.results[0].status); queuedCounts.push([progress.results[0].status, progress.queued]); },
    isRateLimitedError: (error) => error.message === "429",
  }).run();
  await flush();
  assert.deepEqual(attempts, [[1, 0]]);
  assert.ok(snapshots.includes("suspended"));
  assert.ok(queuedCounts.some(([status, queued]) => status === "suspended" && queued === 1));
  await clock.tick(99);
  assert.deepEqual(attempts, [[1, 0]]);
  await clock.tick(1);
  assert.deepEqual(attempts, [[1, 0], [2, 100]]);
  assert.equal((await resultPromise)[0].status, "completed");
}

// Abort marks queued work immediately but waits for active launcher cleanup.
{
  const clock = new FakeClock();
  const controller = new AbortController();
  let cleaned = false; let settled = false;
  const resultPromise = new SwarmBatch([1, 2, 3], (_task, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener("abort", async () => { await Promise.resolve(); cleaned = true; reject(context.signal.reason); }, { once: true });
  }), { maxConcurrency: 1, clock, signal: controller.signal }).run();
  resultPromise.then(() => { settled = true; });
  await flush();
  controller.abort();
  assert.equal(settled, false);
  const results = await resultPromise;
  assert.equal(cleaned, true);
  assert.ok(results.every((r) => r.status === "aborted"));
  assert.equal(clock.timers.size, 0);
}

// Timeout is reported as failed and does not retain its timeout timer.
{
  const clock = new FakeClock();
  const resultPromise = new SwarmBatch(["slow"], () => new Promise(() => {}), { timeoutMs: 50, clock }).run();
  await clock.tick(50);
  const [result] = await resultPromise;
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /timed out/i);
  assert.equal(clock.timers.size, 0);
}

console.log("SWARM_BATCH_TEST_OK");
