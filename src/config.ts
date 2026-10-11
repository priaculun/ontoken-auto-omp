import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SLOTS = ["fast", "work", "solid", "strong", "frontier"] as const;
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const BUDGETS = ["cheap", "balanced", "quality"] as const;
export type Slot = typeof SLOTS[number];
export type Thinking = typeof THINKING[number];
export type Budget = typeof BUDGETS[number];
export interface Config {
  enabled: boolean;
  provider: string;
  budget: Budget;
  slots: Record<Slot, string>;
  maxThinking: Partial<Record<Slot, Thinking>>;
  jev: { model: string; keyFile?: string; promptChars: number; timeoutMs: number };
  adaptive: { contextAware: boolean; shortPromptChars: number; midTurn: boolean; maxEvaluationsPerTurn: number; toolResultsPerEvaluation: number };
  failover: { enabled: boolean; chain: Partial<Record<Slot, Slot[]>> };
}
export const defaults: Config = {
  enabled: false,
  provider: "ontoken",
  budget: "balanced",
  slots: { fast: "gpt-6-luna", work: "glm-5.3-flash", solid: "muse-spark-1.3", strong: "claude-sonnet-5.5", frontier: "claude-opus-5.5" },
  maxThinking: {},
  jev: { model: "jev-latest", promptChars: 16000, timeoutMs: 8000 },
  adaptive: { contextAware: true, shortPromptChars: 800, midTurn: true, maxEvaluationsPerTurn: 2, toolResultsPerEvaluation: 2 },
  failover: { enabled: true, chain: {} },
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function merge(base: ObjectValue, overlay: ObjectValue): ObjectValue {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`Invalid config key: ${key}`);
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : value;
  }
  return result;
}
function readOverlay(path: string): ObjectValue {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}
function validate(value: ObjectValue): Config {
  const allowed: Record<string, readonly string[]> = {
    "": Object.keys(defaults), slots: SLOTS, maxThinking: SLOTS,
    jev: ["model", "keyFile", "promptChars", "timeoutMs"],
    adaptive: Object.keys(defaults.adaptive), failover: ["enabled", "chain"], "failover.chain": SLOTS,
  };
  const visit = (obj: ObjectValue, path: string) => {
    for (const [key, item] of Object.entries(obj)) {
      if (allowed[path] && !allowed[path].includes(key)) throw new Error(`Unknown config field: ${path ? `${path}.` : ""}${key}`);
      if (object(item)) visit(item, path ? `${path}.${key}` : key);
    }
  };
  visit(value, "");
  for (const key of ["slots", "maxThinking", "jev", "adaptive", "failover"])
    if (!object(value[key])) throw new Error(`Invalid config: ${key}`);
  const c = value as unknown as Config;
  if (!object(c.failover.chain)) throw new Error("Invalid failover.chain");
  for (const [name, item] of Object.entries({ enabled: c.enabled, contextAware: c.adaptive.contextAware, midTurn: c.adaptive.midTurn, failover: c.failover.enabled }))
    if (typeof item !== "boolean") throw new Error(`Invalid boolean: ${name}`);
  for (const [name, item] of Object.entries({ provider: c.provider, model: c.jev.model, ...c.slots }))
    if (typeof item !== "string" || !item.trim()) throw new Error(`Invalid model/provider: ${name}`);
  if (c.jev.keyFile !== undefined && (typeof c.jev.keyFile !== "string" || !c.jev.keyFile.trim())) throw new Error("Invalid jev.keyFile");
  if (!BUDGETS.includes(c.budget)) throw new Error("budget must be cheap, balanced or quality");
  for (const level of Object.values(c.maxThinking)) if (!THINKING.includes(level)) throw new Error("Invalid maxThinking level");
  for (const chain of Object.values(c.failover.chain))
    if (!Array.isArray(chain) || chain.some(slot => !SLOTS.includes(slot))) throw new Error("Invalid failover chain");
  for (const [name, item, min, max] of [
    ["promptChars", c.jev.promptChars, 1000, 64000], ["timeoutMs", c.jev.timeoutMs, 100, 15000],
    ["shortPromptChars", c.adaptive.shortPromptChars, 0, 64000],
    ["maxEvaluationsPerTurn", c.adaptive.maxEvaluationsPerTurn, 0, 5],
    ["toolResultsPerEvaluation", c.adaptive.toolResultsPerEvaluation, 1, 10],
  ] as const) if (!Number.isSafeInteger(item) || item < min || item > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return c;
}
export function configPaths(agentDir: string, cwd: string): string[] {
  return [join(agentDir, "ontoken-auto.json"), join(cwd, ".omp", "ontoken-auto.json")];
}
export function loadConfig(agentDir: string, cwd: string, session: ObjectValue = {}): Config {
  let value = structuredClone(defaults) as unknown as ObjectValue;
  for (const path of configPaths(agentDir, cwd)) value = merge(value, readOverlay(path));
  return validate(merge(value, session));
}
export function readKey(agentDir: string, cfg: Config): string | undefined {
  const paths = cfg.jev.keyFile ? [cfg.jev.keyFile] : [join(agentDir, "secrets", "typesafe_api_key")];
  for (const path of paths) {
    try {
      const line = readFileSync(path, "utf8").split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#"));
      if (line) return line;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function ceiling(cfg: Config): number { return cfg.budget === "cheap" ? 2 : 4; }
