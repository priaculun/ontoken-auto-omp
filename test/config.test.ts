import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("project overrides global; session changes only their requested fields", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-auto-config-"));
  try {
    const agent = join(root, "agent"), cwd = join(root, "work");
    mkdirSync(agent); mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(agent, "ontoken-auto.json"), JSON.stringify({ budget: "cheap", slots: { work: "global-work" } }));
    writeFileSync(join(cwd, ".omp", "ontoken-auto.json"), JSON.stringify({ budget: "quality", slots: { solid: "project-solid" } }));
    const cfg = loadConfig(agent, cwd, { slots: { fast: "session-fast" } });
    expect(cfg.budget).toBe("quality");
    expect(cfg.slots.work).toBe("global-work"); expect(cfg.slots.solid).toBe("project-solid"); expect(cfg.slots.fast).toBe("session-fast");
    expect(loadConfig(agent, cwd).slots.fast).toBe("gpt-6-luna");
  } finally { rmSync(root, { recursive: true }); }
});
test("malformed and obsolete Pi config fields do not silently change routing", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-auto-invalid-"));
  try {
    expect(() => loadConfig(root, root, { adaptive: { toolResultsPerEvaluation: 0 } })).toThrow("toolResultsPerEvaluation");
    expect(() => loadConfig(root, root, { virtual: { id: "auto" } })).toThrow("Unknown config field");
    expect(() => loadConfig(root, root, { slots: null })).toThrow("slots");
    expect(() => loadConfig(root, root, { failover: { chain: { work: ["unknown"] } } })).toThrow("chain");
  } finally { rmSync(root, { recursive: true }); }
});
