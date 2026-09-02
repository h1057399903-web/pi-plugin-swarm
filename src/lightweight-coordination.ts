import { realpath as fsRealpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const MAX_TOUCHED_FILES_PER_WORKER = 32;
export const MAX_TRACKED_WORKERS = 128;
export const MAX_SAFE_PATH_LENGTH = 512;
const MAX_TRACKED_FILES = MAX_TOUCHED_FILES_PER_WORKER * MAX_TRACKED_WORKERS;

export type Realpath = (value: string) => Promise<string>;

export interface WorkspaceTargetOptions {
  workspaceRoot: string;
  workingDirectory?: string;
  target: string;
  realpath?: Realpath;
  /** The runtime already canonicalizes these roots before any worker starts. */
  rootsAreCanonical?: boolean;
}

export interface ResolvedWorkspaceTarget {
  /** Canonical, workspace-relative display path. Never absolute. */
  relativePath: string;
  /** Canonical comparison key; case-folded only for Windows paths. */
  identity: string;
}

export interface CoordinationWorkerSnapshot {
  workerId: string;
  touchedFiles: string[];
  overlapFiles: string[];
}

export interface CoordinationResult {
  affectedWorkerIds: string[];
}

function windowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function pathApiFor(root: string): typeof posix | typeof win32 {
  return windowsPath(root) || root.includes("\\") ? win32 : posix;
}

function inside(candidate: string, root: string, pathApi: typeof posix | typeof win32): boolean {
  const rel = pathApi.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

async function canonicalizeTarget(
  candidate: string,
  realpath: Realpath,
  pathApi: typeof posix | typeof win32,
): Promise<string> {
  try {
    return pathApi.normalize(await realpath(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    const parent = pathApi.dirname(candidate);
    const canonicalParent = pathApi.normalize(await realpath(parent));
    return pathApi.join(canonicalParent, pathApi.basename(candidate));
  }
}

/**
 * Resolve a tool target to a canonical, workspace-relative identity.
 * Existing files follow realpath; a missing final leaf follows its canonical parent.
 */
export async function resolveWorkspaceTarget(options: WorkspaceTargetOptions): Promise<ResolvedWorkspaceTarget | undefined> {
  if (typeof options.target !== "string" || !options.target || options.target.includes("\0")) return undefined;
  const pathApi = pathApiFor(options.workspaceRoot);
  const realpath = options.realpath ?? fsRealpath;
  if (pathApi === posix && windowsPath(options.target)) return undefined;

  let root: string;
  let cwd: string;
  try {
    root = pathApi.normalize(options.rootsAreCanonical ? options.workspaceRoot : await realpath(options.workspaceRoot));
    const requestedCwd = options.workingDirectory ?? root;
    cwd = pathApi.normalize(options.rootsAreCanonical ? requestedCwd : await realpath(requestedCwd));
  } catch {
    return undefined;
  }
  if (!inside(cwd, root, pathApi)) return undefined;

  const candidate = pathApi.normalize(pathApi.isAbsolute(options.target)
    ? options.target
    : pathApi.resolve(cwd, options.target));
  // Never turn a lexically outside target into an apparently safe path through a symlink.
  if (!inside(candidate, root, pathApi)) return undefined;

  let canonicalTarget: string;
  try {
    canonicalTarget = await canonicalizeTarget(candidate, realpath, pathApi);
  } catch {
    return undefined;
  }
  if (!inside(canonicalTarget, root, pathApi)) return undefined;

  const relativePath = pathApi.relative(root, canonicalTarget).replaceAll("\\", "/");
  if (!relativePath || relativePath.length > MAX_SAFE_PATH_LENGTH || relativePath.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return {
    relativePath,
    identity: pathApi === win32 ? relativePath.toLowerCase() : relativePath,
  };
}

/** Run-scoped advisory write registry. It never waits, blocks, cancels, or persists. */
export class LightweightCoordination {
  private readonly filesByWorker = new Map<string, Map<string, string>>();
  private readonly writersByFile = new Map<string, Set<string>>();
  private readonly overlapsByWorker = new Map<string, Set<string>>();

  recordWrite(workerId: string, target: ResolvedWorkspaceTarget): CoordinationResult {
    let files = this.filesByWorker.get(workerId);
    if (!files) {
      if (this.filesByWorker.size >= MAX_TRACKED_WORKERS) return { affectedWorkerIds: [] };
      files = new Map();
      this.filesByWorker.set(workerId, files);
    }
    if (files.has(target.identity)) return { affectedWorkerIds: [] };
    if (files.size >= MAX_TOUCHED_FILES_PER_WORKER || (!this.writersByFile.has(target.identity) && this.writersByFile.size >= MAX_TRACKED_FILES)) {
      return { affectedWorkerIds: [] };
    }

    files.set(target.identity, target.relativePath);
    let writers = this.writersByFile.get(target.identity);
    if (!writers) {
      writers = new Set();
      this.writersByFile.set(target.identity, writers);
    }
    writers.add(workerId);
    if (writers.size < 2) return { affectedWorkerIds: [workerId] };

    for (const writerId of writers) {
      let overlaps = this.overlapsByWorker.get(writerId);
      if (!overlaps) this.overlapsByWorker.set(writerId, overlaps = new Set());
      overlaps.add(target.identity);
    }
    return { affectedWorkerIds: [...writers] };
  }

  snapshot(workerId: string): CoordinationWorkerSnapshot {
    const files = this.filesByWorker.get(workerId) ?? new Map<string, string>();
    const overlaps = this.overlapsByWorker.get(workerId) ?? new Set<string>();
    return {
      workerId,
      touchedFiles: [...files.values()].slice(0, MAX_TOUCHED_FILES_PER_WORKER),
      overlapFiles: [...overlaps].map((identity) => files.get(identity)).filter((path): path is string => Boolean(path)).slice(0, MAX_TOUCHED_FILES_PER_WORKER),
    };
  }

  clear(): void {
    this.filesByWorker.clear();
    this.writersByFile.clear();
    this.overlapsByWorker.clear();
  }
}
