import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SwarmAgentRuntime } from "../src/swarm-agent-runtime.ts";

const ownerSessionId = `live-resume-${randomUUID()}`;
const agentId = randomUUID();
const runtime = new SwarmAgentRuntime();
const ownerScope = createHash("sha256").update(ownerSessionId).digest("hex").slice(0, 32);
const directory = join(getAgentDir(), "swarm", "sessions", ownerScope);
try {
  const first = await runtime.run({ workerId: "first", agentId, ownerSessionId, persist: true, cwd: "/tmp", timeoutMs: 120_000, prompt: "The fictional project codename for this test is RIVER_COBALT_731. Remember it for the next turn and reply exactly SAVED." });
  const second = await runtime.run({ workerId: "second", agentId, ownerSessionId, persist: true, resume: true, cwd: "/tmp", timeoutMs: 120_000, prompt: "Reply with the fictional project codename from the prior turn, and nothing else." });
  const summary = { first: { status: first.status, agentId: first.agentId, output: first.output }, second: { status: second.status, agentId: second.agentId, output: second.output } };
  console.log(JSON.stringify(summary, null, 2));
  if (first.status !== "completed" || first.output !== "SAVED" || second.status !== "completed" || second.output !== "RIVER_COBALT_731" || first.agentId !== second.agentId) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
