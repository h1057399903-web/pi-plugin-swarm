import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type SwarmModelCostClass = "free" | "trial" | "subscription" | "metered" | "unknown";
export const PRIMARY_SWARM_MODEL_ALIAS = "primary" as const;

export interface SwarmModelPoolEntry {
  target: string;
  description: string;
  costClass: SwarmModelCostClass;
}

export interface SwarmModelPool {
  defaultModel: string;
  models: Record<string, SwarmModelPoolEntry>;
}

export interface SwarmModelPoolLoadResult {
  configured: boolean;
  pool?: SwarmModelPool;
  /** Bounded configuration error safe to show without file contents or paths. */
  error?: string;
}

const MAX_MODELS = 32;
const MAX_ALIAS_LENGTH = 64;
const MAX_TARGET_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 200;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COST_CLASSES = new Set<SwarmModelCostClass>(["free", "trial", "subscription", "metered", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTarget(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TARGET_LENGTH || value.trim() !== value) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function validAlias(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ALIAS_LENGTH && ALIAS_RE.test(value);
}

function normalizeDescription(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("each model description must be a string");
  return value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function normalizeCostClass(value: unknown): SwarmModelCostClass {
  if (value === undefined) return "unknown";
  if (typeof value !== "string" || !COST_CLASSES.has(value as SwarmModelCostClass)) {
    throw new Error("costClass must be free, trial, subscription, metered, or unknown");
  }
  return value as SwarmModelCostClass;
}

function parseEntry(value: unknown): SwarmModelPoolEntry {
  if (typeof value === "string") {
    if (!validTarget(value)) throw new Error("each model target must be provider/model");
    return { target: value, description: "", costClass: "unknown" };
  }
  if (!isRecord(value) || !validTarget(value.target)) throw new Error("each model entry must include a valid provider/model target");
  return {
    target: value.target,
    description: normalizeDescription(value.description),
    costClass: normalizeCostClass(value.costClass),
  };
}

export function parseSwarmModelPool(value: unknown): SwarmModelPool {
  if (!isRecord(value)) throw new Error("model pool must be a JSON object");
  if (!validAlias(value.defaultModel)) throw new Error("defaultModel must be a valid alias");
  if (value.defaultModel === PRIMARY_SWARM_MODEL_ALIAS) throw new Error("primary is reserved and cannot be the configured defaultModel");
  if (!isRecord(value.models)) throw new Error("models must be an alias-to-model object");

  const entries = Object.entries(value.models);
  if (entries.length === 0 || entries.length > MAX_MODELS) throw new Error(`models must contain 1-${MAX_MODELS} aliases`);
  const models: Record<string, SwarmModelPoolEntry> = {};
  for (const [alias, rawEntry] of entries) {
    if (!validAlias(alias)) throw new Error(`invalid model alias: ${alias.slice(0, MAX_ALIAS_LENGTH)}`);
    if (alias === PRIMARY_SWARM_MODEL_ALIAS) throw new Error("primary is a reserved Swarm model alias");
    models[alias] = parseEntry(rawEntry);
  }
  if (!Object.hasOwn(models, value.defaultModel)) throw new Error("defaultModel must name one of the configured aliases");
  return { defaultModel: value.defaultModel, models };
}

function boundedConfigError(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid model pool configuration";
  return `Swarm model pool configuration is invalid: ${message}`.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

/**
 * Load a private, local whitelist. Missing file means legacy single-model behavior.
 * If a file exists but is invalid, configured=true/error is returned so callers fail closed.
 */
export function loadSwarmModelPool(
  agentDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SwarmModelPoolLoadResult {
  const override = env.PI_SWARM_MODEL_POOL?.trim();
  if (override?.toLowerCase() === "off") return { configured: false };
  const path = override ? resolve(override) : join(agentDir, "swarm-models.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { configured: true, pool: parseSwarmModelPool(parsed) };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") return { configured: false };
    return { configured: true, error: boundedConfigError(error) };
  }
}

export function describeSwarmModelPool(pool: SwarmModelPool): string {
  const lines = ["Whitelisted Swarm models (pass an alias via swarm.model; omit it for the default):"];
  for (const [alias, entry] of Object.entries(pool.models)) {
    const flags = `${alias === pool.defaultModel ? " [default]" : ""} [${entry.costClass}]`;
    lines.push(`- ${alias}${flags}${entry.description ? `: ${entry.description}` : ""}`);
  }
  lines.push(`- ${PRIMARY_SWARM_MODEL_ALIAS} [main]: current main model with its current thinking level; use for hard or quality-sensitive work`);
  return lines.join("\n");
}
