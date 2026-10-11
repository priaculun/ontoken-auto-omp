import { expect, test } from "bun:test";
import { defaults } from "../src/config.ts";
import { heuristic, pickRoute, redact, resolveRoute, transientError, type Verdict } from "../src/routing.ts";
import type { Model } from "@oh-my-pi/pi-ai";

const hard: Verdict = { task: "design", difficulty: 4, needsReasoning: true, needsVision: false, longHorizon: true, confidence: 0.9, source: "jev" };
function model(id: string, vision = true): Model {
  return { provider: "ontoken", id, api: "openai-completions", name: id, baseUrl: "http://localhost/v1", reasoning: true,
    thinking: { efforts: ["low", "high"] }, input: vision ? ["text", "image"] : ["text"],
    contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model;
}
test("cheap budget cannot escape through missing-slot resolution", () => {
  const cfg = { ...defaults, budget: "cheap" as const };
  const route = pickRoute(cfg, hard);
  expect(route.slot).toBe("solid");
  expect(resolveRoute(cfg, route, [model(cfg.slots.frontier)], false)).toBeUndefined();
});
test("adaptive promotion cannot fall back to a weaker available model", () => {
  const route = pickRoute(defaults, hard);
  expect(resolveRoute(defaults, route, [model(defaults.slots.fast)], false, 3)).toBeUndefined();
});
test("image work rejects text-only candidates and picks a budget-compatible vision model", () => {
  const cfg = { ...defaults, budget: "cheap" as const };
  const found = resolveRoute(cfg, { slot: "solid", thinking: "high", rule: "image" }, [model(cfg.slots.solid, false), model(cfg.slots.work)], true);
  expect(found?.model.id).toBe(cfg.slots.work);
  expect(found?.route.slot).toBe("work");
});
test("thinking cap applies to actual fallback model", () => {
  const cfg = { ...defaults, maxThinking: { work: "low" as const } };
  const found = resolveRoute(cfg, { slot: "solid", thinking: "max", rule: "hard" }, [model(cfg.slots.work)], false);
  expect(found?.route.thinking).toBe("low");
});
test("heuristic recognizes Indonesian implementation without selecting chat", () => {
  const v = heuristic("buat extension untuk omp", false);
  expect(v.task).toBe("coding");
  expect(pickRoute(defaults, v).slot).toBe("work");
  expect(pickRoute(defaults, heuristic("refactor arsitektur", false)).thinking).toBe("low");
});
test("failover excludes auth, billing, abort and context overflow even with server wording", () => {
  for (const error of ["401 unavailable", "429 quota exceeded", "billing 503", "aborted network", "context length timeout", "400 invalid api key"])
    expect(transientError(error)).toBe(false);
  for (const error of ["503 service unavailable", "429 rate limit", "fetch failed", "ECONNRESET", "network timeout"])
    expect(transientError(error)).toBe(true);
});
test("redaction removes credentials before classifier dispatch", () => {
  const text = redact("api_key=topsecret Bearer token123 https://user:password@example.com\n-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----");
  for (const secret of ["topsecret", "token123", "user:password", "secret bytes"]) expect(text).not.toContain(secret);
});
