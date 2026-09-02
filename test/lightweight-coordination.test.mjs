import assert from "node:assert/strict";
import { LightweightCoordination, MAX_TOUCHED_FILES_PER_WORKER, resolveWorkspaceTarget } from "../src/lightweight-coordination.ts";

const identity = async (value) => value;
const resolve = (target, extra = {}) => resolveWorkspaceTarget({ workspaceRoot: "/repo", workingDirectory: "/repo", target, realpath: identity, ...extra });

assert.equal((await resolve("src/../src/file.ts")).relativePath, "src/file.ts");
assert.equal((await resolve("/repo/src/file.ts")).relativePath, "src/file.ts", "safe absolute targets are projected relative");
assert.equal(await resolve("/outside/file.ts"), undefined);
assert.equal(await resolve("../outside.ts"), undefined);
assert.equal((await resolve("file.ts", { workingDirectory: "/repo/packages/app" })).relativePath, "packages/app/file.ts");

const symlinkRealpath = async (value) => {
  if (value === "/repo/alias/file.ts") { return "/repo/src/file.ts"; }
  if (value === "/repo/escape/file.ts") { return "/outside/file.ts"; }
  return value;
};
assert.equal((await resolve("alias/file.ts", { realpath: symlinkRealpath })).relativePath, "src/file.ts");
assert.equal(await resolve("escape/file.ts", { realpath: symlinkRealpath }), undefined, "canonical symlink escapes are not tracked or exposed");

const missingLeaf = async (value) => {
  if (value === "/repo/src/new.ts") { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
  if (value === "/repo/link/new.ts") { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
  if (value === "/repo/link") { return "/outside"; }
  return value;
};
assert.equal((await resolve("src/new.ts", { realpath: missingLeaf })).relativePath, "src/new.ts");
assert.equal(await resolve("link/new.ts", { realpath: missingLeaf }), undefined, "a missing leaf still canonicalizes its parent");

const registry = new LightweightCoordination();
const first = await resolve("src/auth.ts");
const sameNormalized = await resolve("src/./auth.ts");
const differentDirectory = await resolve("test/auth.ts");
assert.deepEqual(registry.recordWrite("a", first).affectedWorkerIds, ["a"]);
assert.deepEqual(registry.recordWrite("b", differentDirectory).affectedWorkerIds, ["b"], "same basename in another directory is not overlap");
assert.deepEqual(registry.recordWrite("c", sameNormalized).affectedWorkerIds.sort(), ["a", "c"]);
assert.deepEqual(registry.snapshot("a"), { workerId: "a", touchedFiles: ["src/auth.ts"], overlapFiles: ["src/auth.ts"] });
assert.deepEqual(registry.snapshot("c"), { workerId: "c", touchedFiles: ["src/auth.ts"], overlapFiles: ["src/auth.ts"] });
assert.deepEqual(registry.recordWrite("a", first).affectedWorkerIds, [], "one worker repeating a write is not a conflict");
assert.deepEqual(registry.snapshot("reader"), { workerId: "reader", touchedFiles: [], overlapFiles: [] }, "reads never enter the write registry");

const winIdentity = async (value) => value.replaceAll("/", "\\");
const winA = await resolveWorkspaceTarget({ workspaceRoot: "C:\\Repo", target: "src\\File.TXT", realpath: winIdentity });
const winB = await resolveWorkspaceTarget({ workspaceRoot: "C:\\Repo", target: "SRC/file.txt", realpath: winIdentity });
const windowsRegistry = new LightweightCoordination();
windowsRegistry.recordWrite("one", winA);
assert.deepEqual(windowsRegistry.recordWrite("two", winB).affectedWorkerIds.sort(), ["one", "two"], "Windows identities are case-insensitive");

const bounded = new LightweightCoordination();
for (let index = 0; index < MAX_TOUCHED_FILES_PER_WORKER + 8; index++) {
  bounded.recordWrite("bounded", { relativePath: `files/${index}.ts`, identity: `files/${index}.ts` });
}
assert.equal(bounded.snapshot("bounded").touchedFiles.length, MAX_TOUCHED_FILES_PER_WORKER);
bounded.clear();
assert.deepEqual(bounded.snapshot("bounded"), { workerId: "bounded", touchedFiles: [], overlapFiles: [] });

console.log("LIGHTWEIGHT_COORDINATION_TEST_OK");
