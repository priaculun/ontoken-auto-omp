import { expect, test } from "bun:test";
import { defaults } from "../src/config.ts";
import { heuristic, pickRoute, type Verdict } from "../src/routing.ts";

function verdict(over: Partial<Verdict>): Verdict {
  return { task: "coding", difficulty: 1, risk: false, needsReasoning: false, needsVision: false, longHorizon: false, confidence: 0.9, source: "jev", ...over };
}
test("routine review lands on the review specialist, high-stakes review escalates to strong", () => {
  expect(pickRoute(defaults, verdict({ task: "review", difficulty: 1 })).slot).toBe("review");
  expect(pickRoute(defaults, verdict({ task: "review", difficulty: 1, risk: true })).slot).toBe("strong");
});
test("debug difficulty ladder: routine work, hard debug specialist, frontier debug to strong", () => {
  expect(pickRoute(defaults, verdict({ task: "debug", difficulty: 1 })).slot).toBe("work");
  expect(pickRoute(defaults, verdict({ task: "debug", difficulty: 3 })).slot).toBe("debug");
  expect(pickRoute(defaults, verdict({ task: "debug", difficulty: 4 })).slot).toBe("strong");
});
test("high-risk work never routes below solid even when difficulty is low", () => {
  const route = pickRoute(defaults, verdict({ task: "coding", difficulty: 1, risk: true }));
  expect(route.slot).toBe("solid");
  expect(route.rule).toContain("+risk");
});
test("cheap budget caps routing at debug specialist, balanced reaches frontier", () => {
  const cheap = { ...defaults, budget: "cheap" as const };
  expect(pickRoute(cheap, verdict({ difficulty: 4, needsReasoning: true })).slot).toBe("debug");
  expect(pickRoute(defaults, verdict({ difficulty: 4, needsReasoning: true })).slot).toBe("frontier");
});
test("heuristic keeps risk flag consistent with hard-task detection", () => {
  const hard = heuristic("refactor arsitektur dan migrasi database besar", false);
  expect(hard.risk).toBe(true);
  const trivial = heuristic("halo apa kabar", false);
  expect(trivial.risk).toBe(false);
});
