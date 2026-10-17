import { Effort } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { classify } from "./classifier.ts";
import { BUDGETS, SLOTS, THINKING, ceiling, configPaths, loadConfig, type Budget, type Config, type Slot } from "./config.ts";
import { contentText, confirmDemotion, heuristic, pickRoute, redact, resolveRoute, transientError, type DemoteTally, type Route, type Verdict } from "./routing.ts";
interface State {
  route: Route;
  modelId: string;
  verdict: Verdict;
  evaluations: number;
  toolsAtEvaluation: number;
  tried: string[];
  failedOver: boolean;
}
const STATE = "omp-ontoken-auto:route";
const OPTIONS = "omp-ontoken-auto:options";
const EFFORTS: Record<typeof THINKING[number], Parameters<ExtensionAPI["setThinkingLevel"]>[0]> = {
  off: "off", minimal: Effort.Minimal, low: Effort.Low, medium: Effort.Medium,
  high: Effort.High, xhigh: Effort.XHigh, max: Effort.Max,
};

export default function ontokenAuto(omp: ExtensionAPI) {
  // Factory-local: OMP rebinds factories for children; module globals would leak state.
  const agentDir = omp.pi.getAgentDir();
  const z = omp.zod;
  const slotSchema = z.enum(SLOTS);
  const stateSchema = z.object({
    route: z.object({ slot: slotSchema, thinking: z.enum(THINKING), rule: z.string() }),
    modelId: z.string(),
    verdict: z.object({ task: z.string(), difficulty: z.number(), needsReasoning: z.boolean(), needsVision: z.boolean(),
      longHorizon: z.boolean(), confidence: z.number(), source: z.enum(["jev", "fallback"]), error: z.string().optional() }),
    evaluations: z.number(), toolsAtEvaluation: z.number(), tried: z.array(z.string()), failedOver: z.boolean(),
  });
  const optionSchema = z.object({
    enabled: z.boolean().optional(), budget: z.enum(BUDGETS).optional(),
    slots: z.object({ fast: z.string().optional(), work: z.string().optional(), solid: z.string().optional(),
      strong: z.string().optional(), frontier: z.string().optional() }).optional(),
  });
  let options: Record<string, unknown> = {};
  let state: State | undefined;
  let controller = new AbortController();
  let active = false;
  let objective = "";
  let hasImage = false;
  let lastExplain = "Belum ada routing.";
  let progress: string[] = [];
  let tools = 0;
  let pending: Promise<void> | undefined;
  const seenTools = new Set<string>();
  let demote: DemoteTally = { slot: undefined, votes: 0 };
  function config(ctx: ExtensionContext): Config { return loadConfig(agentDir, ctx.cwd, options); }
  function record(ctx: ExtensionContext, reason: string) {
    if (!state) return;
    omp.appendEntry(STATE, structuredClone(state));
    const v = state.verdict;
    lastExplain = `${reason}\nsource=${v.source}${v.error ? ` (${v.error})` : ""}\ntask=${v.task} difficulty=${v.difficulty}/4 confidence=${v.confidence.toFixed(2)}\nrule=${state.route.rule}\n→ ${state.route.slot}: ${state.modelId} thinking=${state.route.thinking}`;
    ctx.ui.setStatus("ontoken-auto", `${state.route.slot} → ${state.modelId} · ${state.route.thinking}`);
  }
  function reset() {
    controller.abort(); controller = new AbortController();
    active = false; pending = undefined; objective = ""; progress = []; tools = 0; seenTools.clear();
    demote = { slot: undefined, votes: 0 };
  }
  function restore(ctx: ExtensionContext) {
    reset(); options = {}; state = undefined; lastExplain = "Belum ada routing.";
    if (ctx.agent.kind !== "main") return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === OPTIONS) options = optionSchema.parse(entry.data);
      if (entry.customType === STATE) state = stateSchema.parse(entry.data);
    }
    if (state) lastExplain = `Restored: ${state.modelId} · ${state.route.thinking} (${state.route.rule})`;
    ctx.ui.setStatus("ontoken-auto", config(ctx).enabled ? "auto siap" : undefined);
  }
  omp.on("session_start", (_event, ctx) => restore(ctx));
  omp.on("session_switch", (_event, ctx) => restore(ctx));
  omp.on("session_branch", (_event, ctx) => restore(ctx));
  omp.on("session_tree", (_event, ctx) => restore(ctx));
  omp.on("session_shutdown", reset);
  omp.on("session_stop", () => { reset(); });

  async function verdict(prompt: string, cfg: Config, ctx: ExtensionContext, signal: AbortSignal): Promise<Verdict> {
    try {
      return await classify(prompt, hasImage, cfg, ctx, agentDir, AbortSignal.any([signal, AbortSignal.timeout(cfg.jev.timeoutMs)]));
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...heuristic(prompt, hasImage), error: "Jev timeout; using local heuristic" };
    }
  }
  async function apply(cfg: Config, ctx: ExtensionContext, picked: Route, v: Verdict, signal: AbortSignal, minSlot = 0): Promise<boolean> {
    signal.throwIfAborted();
    const resolved = resolveRoute(cfg, picked, ctx.models.list(), v.needsVision, minSlot);
    if (!resolved) {
      lastExplain = "Tidak ada model roster yang tersedia dalam budget/modalitas; model aktif tidak diubah.";
      ctx.ui.notify(lastExplain, "warning");
      return false;
    }
    const fast = ctx.models.list().find(m => m.provider === cfg.provider && m.id === cfg.slots.fast);
    // OMP compacts on this concrete model without switching the conversation model.
    const model = fast ? { ...resolved.model, compactionModel: `${fast.provider}/${fast.id}` } : resolved.model;
    if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id || ctx.model.compactionModel !== model.compactionModel) {
      if (!await omp.setModel(model)) { lastExplain = "Credential model tujuan tidak tersedia; model aktif tidak diubah."; return false; }
    }
    signal.throwIfAborted();
    omp.setThinkingLevel(EFFORTS[resolved.route.thinking]);
    const effectiveThinking = omp.getThinkingLevel();
    state = { route: { ...resolved.route, thinking: THINKING.find(level => level === effectiveThinking) ?? resolved.route.thinking }, modelId: model.id, verdict: v,
      evaluations: state?.evaluations ?? 0, toolsAtEvaluation: state?.toolsAtEvaluation ?? 0,
      tried: state?.tried ?? [], failedOver: state?.failedOver ?? false };
    return true;
  }

  omp.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const cfg = config(ctx);
    if (!cfg.enabled) return;
    // setModel can cause policy-preparation re-entry for this same delivery.
    if (active && objective.endsWith(`CURRENT USER REQUEST:\n${redact(event.prompt)}`)) return;
    reset(); active = true; state = undefined;
    const signal = controller.signal;
    hasImage = (event.images?.length ?? 0) > 0;
    const current = `CURRENT USER REQUEST:\n${redact(event.prompt)}`;
    const context: string[] = [];
    if (cfg.adaptive.contextAware && event.prompt.length <= cfg.adaptive.shortPromptChars) {
      let remaining = Math.max(0, cfg.jev.promptChars - current.length - 2);
      const branch = ctx.sessionManager.getBranch();
      for (let i = branch.length - 1; i >= 0 && remaining > 80; i--) {
        const entry = branch[i];
        let text = "";
        if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
          text = `${entry.message.role}:\n${redact(contentText(entry.message.content))}`;
        } else if (entry.type === "compaction") text = `CONVERSATION SUMMARY:\n${redact(entry.summary)}`;
        if (!text.trim()) continue;
        text = text.slice(-Math.min(4000, remaining));
        context.unshift(text); remaining -= text.length + 2;
      }
    }
    objective = [...context, current].join("\n\n").slice(-cfg.jev.promptChars);
    const v = await verdict(objective, cfg, ctx, signal);
    if (!await apply(cfg, ctx, pickRoute(cfg, v), v, signal)) { active = false; return; }
    record(ctx, "User request");
  });

  omp.on("tool_result", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || !active || !state || controller.signal.aborted) return;
    const cfg = config(ctx);
    if (!cfg.enabled || !cfg.adaptive.midTurn || state.failedOver) return;
    if (ctx.model?.provider !== cfg.provider || ctx.model.id !== state.modelId) return;
    if (seenTools.has(event.toolCallId)) return;
    seenTools.add(event.toolCallId); tools++;
    progress.push(`TOOL ${event.toolName}${event.isError ? " ERROR" : ""}:\n${redact(contentText(event.content)).slice(-1800)}`);
    while (progress.join("\n\n").length > cfg.jev.promptChars / 2 && progress.length > 1) progress.shift();
    if (pending) { await pending; return; }
    if (state.evaluations >= cfg.adaptive.maxEvaluationsPerTurn || tools - state.toolsAtEvaluation < cfg.adaptive.toolResultsPerEvaluation) return;
    const previous = state;
    const signal = controller.signal;
    previous.evaluations++; previous.toolsAtEvaluation = tools;
    const run = (async () => {
      const prompt = `TASK:\n${objective.slice(-Math.floor(cfg.jev.promptChars / 2))}\n\nPROGRESS:\n${progress.join("\n\n")}\nReassess remaining work.`;
      const v = await verdict(prompt, cfg, ctx, signal);
      signal.throwIfAborted();
      if (state !== previous || v.source !== "jev") return;
      const picked = pickRoute(cfg, v);
      const target = SLOTS.indexOf(picked.slot), current = SLOTS.indexOf(previous.route.slot);
      if (target > current) {
        // Promotion is immediate; thinking never drops on the way up. Any pending
        // demotion votes are stale once the trajectory turns upward.
        demote = { slot: undefined, votes: 0 };
        if (THINKING.indexOf(picked.thinking) < THINKING.indexOf(previous.route.thinking)) picked.thinking = previous.route.thinking;
      } else if (target < current) {
        // Demotion: only with consent, never mid-turn for risky work, never below work,
        // and only after consecutive evaluations agree on the same lower slot (hysteresis).
        if (!cfg.adaptive.allowDemotion || v.risk || target < SLOTS.indexOf("work")) return;
        if (previous.route.rule.includes("+failover")) return;
        if (!confirmDemotion(demote, picked.slot)) return;
      } else return;
      picked.rule += "+adaptive";
      if (await apply(cfg, ctx, picked, v, signal, target > current ? current + 1 : 0)) record(ctx, `Adaptive ${target > current ? "promotion" : "demotion"} after ${tools} tool results`);
    })();
    pending = run;
    try { await run; } finally { if (pending === run) pending = undefined; }
  });

  omp.on("auto_retry_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || !active || !state || controller.signal.aborted) return;
    const cfg = config(ctx);
    if (!cfg.enabled || !cfg.failover.enabled || !transientError(event.errorMessage)) return;
    // Native OMP fallback may already have switched; never fight that decision.
    if (ctx.model?.provider !== cfg.provider || ctx.model.id !== state.modelId) return;
    const previous = state;
    previous.tried = [...new Set([...previous.tried, previous.modelId])];
    const chain = cfg.failover.chain[previous.route.slot] ?? [...SLOTS].reverse().filter(s => s !== previous.route.slot);
    const available = ctx.models.list();
    for (const slot of chain) {
      if (SLOTS.indexOf(slot) > ceiling(cfg) || previous.tried.includes(cfg.slots[slot])) continue;
      const route = { slot, thinking: previous.route.thinking, rule: previous.route.rule + "+failover" };
      const resolved = resolveRoute(cfg, route, available, previous.verdict.needsVision);
      if (!resolved || resolved.route.slot !== slot || previous.tried.includes(resolved.model.id)) continue;
      if (await apply(cfg, ctx, route, previous.verdict, controller.signal)) {
        state!.failedOver = true;
        record(ctx, `Failover ${previous.modelId} → ${state!.modelId}`);
        ctx.ui.notify(`OnToken failover: ${previous.modelId} → ${state!.modelId}`, "warning");
        return;
      }
    }
    lastExplain = `Failover: tidak ada slot lain dalam budget; OMP melanjutkan retry native.`;
  });

  omp.registerCommand("auto", {
    description: "OnToken router: on/off, budget, slot, status, explain",
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") return;
      const [cmd = "status", value, model, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (cmd === "on" || cmd === "off") {
        options = { ...options, enabled: cmd === "on" };
        if (cmd === "off") reset();
      } else if (cmd === "budget" && BUDGETS.includes(value as Budget) && !model) {
        options = { ...options, budget: value };
      } else if (cmd === "slot" && SLOTS.includes(value as Slot) && model && !extra.length) {
        const cfg = config(ctx);
        const target = ctx.models.list().find(m => m.provider === cfg.provider && m.id === model);
        if (!target) { ctx.ui.notify(`Model ${cfg.provider}/${model} tidak tersedia.`, "warning"); return; }
        options = { ...options, slots: { ...(options.slots as Record<string, string> ?? {}), [value]: model } };
      } else if (!["status", "explain"].includes(cmd)) {
        ctx.ui.notify("/auto on|off · /auto budget cheap|balanced|quality · /auto slot fast|work|solid|strong|frontier <model-id> · /auto explain", "info"); return;
      }
      if (!["status", "explain"].includes(cmd)) omp.appendEntry(OPTIONS, options);
      const cfg = config(ctx);
      ctx.ui.setStatus("ontoken-auto", cfg.enabled ? "auto siap" : undefined);
      const header = `enabled=${cfg.enabled} budget=${cfg.budget} provider=${cfg.provider}\n${SLOTS.map(s => `${s}=${cfg.slots[s]}`).join("\n")}\nConfig: ${configPaths(agentDir, ctx.cwd).join(" → ")}\nCommands change this session only.`;
      ctx.ui.notify(`${header}\n\n${lastExplain}`, "info");
    },
  });
}
