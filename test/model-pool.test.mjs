import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSwarmModelPool, loadSwarmModelPool, parseSwarmModelPool } from "../src/model-pool.ts";

const pool = parseSwarmModelPool({
  defaultModel: "durable-coder",
  models: {
    "free-research": {
      target: "synthetic/free-model",
      description: "Free broad read-only research",
      costClass: "free",
    },
    "durable-coder": "synthetic/durable-model",
  },
});
assert.equal(pool.defaultModel, "durable-coder");
assert.deepEqual(pool.models["free-research"], {
  target: "synthetic/free-model",
  description: "Free broad read-only research",
  costClass: "free",
});
assert.deepEqual(pool.models["durable-coder"], {
  target: "synthetic/durable-model",
  description: "",
  costClass: "unknown",
});

const summary = describeSwarmModelPool(pool);
assert.match(summary, /free-research \[free\]/);
assert.match(summary, /durable-coder \[default\] \[unknown\]/);
assert.doesNotMatch(summary, /synthetic\/free-model|synthetic\/durable-model/, "coordinator summary must not expose local targets");

assert.throws(() => parseSwarmModelPool({ defaultModel: "missing", models: { allowed: "synthetic/model" } }), /defaultModel/);
assert.throws(() => parseSwarmModelPool({ defaultModel: "bad alias", models: { "bad alias": "synthetic/model" } }), /alias/);
assert.throws(() => parseSwarmModelPool({ defaultModel: "a", models: { a: "missing-provider" } }), /provider\/model/);
assert.throws(() => parseSwarmModelPool({ defaultModel: "a", models: { a: { target: "synthetic/model", costClass: "magic" } } }), /costClass/);

const dir = mkdtempSync(join(tmpdir(), "swarm-model-pool-"));
try {
  assert.deepEqual(loadSwarmModelPool(dir, {}), { configured: false });
  assert.deepEqual(loadSwarmModelPool(dir, { PI_SWARM_MODEL_POOL: "off" }), { configured: false });

  const path = join(dir, "private-pool.json");
  writeFileSync(path, JSON.stringify({
    defaultModel: "research",
    models: { research: { target: "synthetic/research", description: "cheap research", costClass: "trial" } },
  }));
  const loaded = loadSwarmModelPool(dir, { PI_SWARM_MODEL_POOL: path });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.pool.defaultModel, "research");

  writeFileSync(path, "{not-json");
  const invalid = loadSwarmModelPool(dir, { PI_SWARM_MODEL_POOL: path });
  assert.equal(invalid.configured, true);
  assert.match(invalid.error, /configuration is invalid/);
  assert.doesNotMatch(invalid.error, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "config errors must not expose local paths");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("SWARM_MODEL_POOL_TEST_OK");
