import type { Model } from "@oh-my-pi/pi-ai";
import { ceiling, SLOTS, THINKING, type Config, type Slot, type Thinking } from "./config.ts";

export interface Verdict {
  task: string; difficulty: number; needsReasoning: boolean; needsVision: boolean;
  longHorizon: boolean; confidence: number; source: "jev" | "fallback"; error?: string;
}
export interface Route { slot: Slot; thinking: Thinking; rule: string }
export function heuristic(prompt: string, hasImage: boolean): Verdict {
  const hard = /\b(architect|architecture|arsitektur|refactor|deadlock|race|security|keamanan|migrat\w*|design doc)\b/i.test(prompt) || prompt.length > 4000;
  const debug = /\b(bug|crash|failing test|stack trace|hang|reproduc\w*)\b/i.test(prompt);
  const coding = /\b(implement\w*|fix|add|edit|write|test|tulis|buat|ubah|perbaiki|tambahkan)\b/i.test(prompt);
  const task = debug ? "debug" : hard ? "design" : coding ? "coding" : prompt.length < 240 ? "chat" : "research";
  return { task, difficulty: hard || debug ? 3 : coding ? 1 : task === "chat" ? 0 : 2,
    needsReasoning: hard || debug, needsVision: hasImage, longHorizon: hard || prompt.length > 2500, confidence: 0.35, source: "fallback" };
}
export function pickRoute(cfg: Config, v: Verdict): Route {
  let slot: Slot = "work", thinking: Thinking = "low", rule = "fallback";
  if (["chat", "lookup"].includes(v.task) && v.difficulty === 0 && !v.needsReasoning) {
    slot = "fast"; thinking = "off"; rule = "chat-trivial";
  } else if (["mechanical", "coding", "review"].includes(v.task) && v.difficulty <= 1) {
    rule = "routine";
  } else if (v.difficulty <= 2) {
    thinking = "high"; rule = "involved";
  } else if (v.difficulty === 3) {
    slot = cfg.budget === "quality" ? "strong" : "solid"; thinking = "high"; rule = "hard";
  } else if (v.difficulty >= 4) {
    slot = v.needsReasoning ? "frontier" : "strong";
    thinking = v.needsReasoning ? v.confidence >= 0.7 ? "max" : "xhigh" : "high";
    rule = "frontier";
  }
  if (v.longHorizon && SLOTS.indexOf(slot) < 2) { slot = "solid"; thinking = "high"; rule += "+long"; }
  if (SLOTS.indexOf(slot) > ceiling(cfg)) { slot = SLOTS[ceiling(cfg)]; rule += "+budget"; }
  if (v.source === "fallback") thinking = "low";
  return { slot, thinking, rule };
}
export function resolveRoute(cfg: Config, route: Route, models: readonly Model[], needsVision: boolean, minSlot = 0): { model: Model; route: Route } | undefined {
  const requested = SLOTS.indexOf(route.slot);
  const candidates = [requested, ...SLOTS.map((_, i) => i).filter(i => i !== requested)];
  for (const i of candidates) {
    if (i < minSlot || i > ceiling(cfg)) continue;
    const slot = SLOTS[i];
    const model = models.find(m => m.provider === cfg.provider && m.id === cfg.slots[slot] && m.supportsTools !== false && (!needsVision || m.input.includes("image")));
    if (!model) continue;
    let cap = THINKING.indexOf(route.thinking);
    const max = cfg.maxThinking[slot];
    if (max) cap = Math.min(cap, THINKING.indexOf(max));
    const efforts = model.thinking?.efforts ?? [];
    // No supported tier beneath the cap means off; the host enforces mandatory effort.
    const thinking = !model.reasoning || cap === 0 ? "off"
      : [...THINKING.slice(1, cap + 1)].reverse().find(level => efforts.some(effort => effort === level)) ?? "off";
    return { model, route: { ...route, slot, thinking, rule: route.rule + (i !== requested ? "+available" : "") } };
  }
}
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1[REDACTED]@");
}
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
}
export function transientError(message: string): boolean {
  if (/\b(401|403|auth\w*|unauthorized|api key|quota|billing|payment|credit|abort\w*|context\w*|invalid\w*)\b/i.test(message)) return false;
  return /\b(429|5\d\d|overloaded|rate limit|too many requests|timeout|timed out|econn\w*|enotfound|etimedout|socket|network|temporarily|unavailable|fetch failed|bad gateway|internal server error)\b/i.test(message);
}
