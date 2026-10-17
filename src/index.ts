import { Effort } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { classify } from "./classifier.ts";
import { BUDGETS, SLOTS, THINKING, ceiling, configPaths, loadConfig, type Budget, type Config, type Slot } from "./config.ts";
import { adaptiveMove, contentText, heuristic, pickRoute, redact, resolveRoute, transientError, type DemoteTally, type Route, type Verdict } from "./routing.ts";
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
const TRACE = "omp-ontoken-auto:trace";
const TRACE_LIMIT = 30;
interface TraceEvent { t: string; kind: string; detail: string }
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
    debug: z.boolean().optional(),
  });
  const traceSchema = z.object({ events: z.array(z.object({ t: z.string(), kind: z.string(), detail: z.string() })) });
  let options: Record<string, unknown> = {};
  let state: State | undefined;
  let trace: TraceEvent[] = [];
  function traceEvent(ctx: ExtensionContext, kind: string, detail: string) {
    if (!config(ctx).debug) return;
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    trace = [...trace.slice(-(TRACE_LIMIT - 1)), { t: stamp, kind, detail: detail.slice(0, 220) }];
    omp.appendEntry(TRACE, { events: structuredClone(trace) });
  }
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
    reset(); options = {}; state = undefined; trace = []; lastExplain = "Belum ada routing.";
    if (ctx.agent.kind !== "main") return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === OPTIONS) options = optionSchema.parse(entry.data);
      if (entry.customType === STATE) state = stateSchema.parse(entry.data);
      if (entry.customType === TRACE) trace = traceSchema.parse(entry.data).events;
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
  async function apply(cfg: Config, ctx: ExtensionContext, picked: Route, v: Verdict, signal: AbortSignal, minSlot = 0, why = ""): Promise<boolean> {
    signal.throwIfAborted();
    const resolved = resolveRoute(cfg, picked, ctx.models.list(), v.needsVision, minSlot);
    if (!resolved) {
      lastExplain = "Tidak ada model roster yang tersedia dalam budget/modalitas; model aktif tidak diubah.";
      ctx.ui.notify(lastExplain, "warning");
      traceEvent(ctx, "apply", `FAIL ${why} no-model slot=${picked.slot} budget=${cfg.budget}`);
      return false;
    }
    const fast = ctx.models.list().find(m => m.provider === cfg.provider && m.id === cfg.slots.fast);
    // OMP compacts on this concrete model without switching the conversation model.
    const model = fast ? { ...resolved.model, compactionModel: `${fast.provider}/${fast.id}` } : resolved.model;
    let switched = "keep";
    if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id || ctx.model.compactionModel !== model.compactionModel) {
      if (!await omp.setModel(model)) {
        lastExplain = "Credential model tujuan tidak tersedia; model aktif tidak diubah.";
        traceEvent(ctx, "apply", `FAIL ${why} setModel-rejected ${model.provider}/${model.id}`);
        return false;
      }
      switched = "switched";
    }
    signal.throwIfAborted();
    omp.setThinkingLevel(EFFORTS[resolved.route.thinking]);
    const effectiveThinking = omp.getThinkingLevel();
    state = { route: { ...resolved.route, thinking: THINKING.find(level => level === effectiveThinking) ?? resolved.route.thinking }, modelId: model.id, verdict: v,
      evaluations: state?.evaluations ?? 0, toolsAtEvaluation: state?.toolsAtEvaluation ?? 0,
      tried: state?.tried ?? [], failedOver: state?.failedOver ?? false };
    traceEvent(ctx, "apply", `OK ${why} ${resolved.route.slot}=${model.id} ${switched} think=${state.route.thinking}`);
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
    traceEvent(ctx, "verdict", `request src=${v.source} task=${v.task} d=${v.difficulty} risk=${v.risk} conf=${v.confidence.toFixed(2)}`);
    if (!await apply(cfg, ctx, pickRoute(cfg, v), v, signal, 0, "request")) { active = false; return; }
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
      if (state !== previous) return;
      // A fallback verdict carries no slot signal; it must not feed the streak.
      if (v.source !== "jev") { demote = { slot: undefined, votes: 0 }; traceEvent(ctx, "verdict", `adaptive#${previous.evaluations} FALLBACK streak-reset`); return; }
      const picked = pickRoute(cfg, v);
      const demoteEligible = cfg.adaptive.allowDemotion && !v.risk
        && SLOTS.indexOf(picked.slot) >= SLOTS.indexOf("work")
        && !previous.route.rule.includes("+failover");
      const move = adaptiveMove(demote, previous.route.slot, picked.slot, demoteEligible);
      traceEvent(ctx, "adaptive", `#${previous.evaluations} ${previous.route.slot}→${picked.slot} ${move} votes=${demote.votes} elig=${demoteEligible} task=${v.task} d=${v.difficulty} risk=${v.risk}`);
      if (move === "hold") return;
      if (move === "promote" && THINKING.indexOf(picked.thinking) < THINKING.indexOf(previous.route.thinking)) {
        // Promotion is immediate; thinking never drops on the way up.
        picked.thinking = previous.route.thinking;
      }
      picked.rule += "+adaptive";
      const target = SLOTS.indexOf(picked.slot), current = SLOTS.indexOf(previous.route.slot);
      if (await apply(cfg, ctx, picked, v, signal, move === "promote" ? current + 1 : 0, `adaptive-${move}`)) record(ctx, `Adaptive ${move === "promote" ? "promotion" : "demotion"} after ${tools} tool results`);
    })();
    pending = run;
    try { await run; } finally { if (pending === run) pending = undefined; }
  });

  omp.on("auto_retry_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || !active || !state || controller.signal.aborted) return;
    const cfg = config(ctx);
    if (cfg.debug) traceEvent(ctx, "retry", `error=${String(event.errorMessage).slice(0, 120)} transient=${transientError(event.errorMessage)}`);
    if (!cfg.enabled || !cfg.failover.enabled || !transientError(event.errorMessage)) {
      if (cfg.debug) traceEvent(ctx, "retry", "skip: non-transient/disabled");
      return;
    }
    // Native OMP fallback may already have switched; never fight that decision.
    if (ctx.model?.provider !== cfg.provider || ctx.model.id !== state.modelId) { traceEvent(ctx, "retry", "skip: native already switched"); return; }
    const previous = state;
    previous.tried = [...new Set([...previous.tried, previous.modelId])];
    const chain = cfg.failover.chain[previous.route.slot] ?? [...SLOTS].reverse().filter(s => s !== previous.route.slot);
    const available = ctx.models.list();
    for (const slot of chain) {
      if (SLOTS.indexOf(slot) > ceiling(cfg) || previous.tried.includes(cfg.slots[slot])) continue;
      const route = { slot, thinking: previous.route.thinking, rule: previous.route.rule + "+failover" };
      const resolved = resolveRoute(cfg, route, available, previous.verdict.needsVision);
      if (!resolved || resolved.route.slot !== slot || previous.tried.includes(resolved.model.id)) continue;
      if (await apply(cfg, ctx, route, previous.verdict, controller.signal, 0, `failover-${slot}`)) {
        state!.failedOver = true;
        record(ctx, `Failover ${previous.modelId} → ${state!.modelId}`);
        ctx.ui.notify(`OnToken failover: ${previous.modelId} → ${state!.modelId}`, "warning");
        return;
      }
    }
    traceEvent(ctx, "retry", "exhausted: no other slot; native retry continues");
    lastExplain = `Failover: tidak ada slot lain dalam budget; OMP melanjutkan retry native.`;
  });

  omp.registerCommand("auto", {
    description: "OnToken router: on/off, debug on/off, budget, slot, status, explain",
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") return;
      const [cmd = "status", value, model, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if ((cmd === "debug" && (value === "on" || value === "off")) && !model && !extra.length) {
        options = { ...options, debug: value === "on" };
        if (value === "off") trace = [];
      } else if (cmd === "on" || cmd === "off") {
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
        ctx.ui.notify("/auto on|off · /auto debug on|off · /auto budget cheap|balanced|quality · /auto slot fast|work|solid|strong|frontier <model-id> · /auto explain", "info"); return;
      }
      if (!["status", "explain"].includes(cmd)) omp.appendEntry(OPTIONS, options);
      const cfg = config(ctx);
      ctx.ui.setStatus("ontoken-auto", cfg.enabled ? "auto siap" : undefined);
      const header = `enabled=${cfg.enabled} debug=${cfg.debug} budget=${cfg.budget} provider=${cfg.provider}\n${SLOTS.map(s => `${s}=${cfg.slots[s]}`).join("\n")}\nConfig: ${configPaths(agentDir, ctx.cwd).join(" → ")}\nCommands change this session only.`;
      const traceBlock = trace.length ? `\n\ntrace (${trace.length}):\n${trace.map(e => `[${e.t}] ${e.kind}: ${e.detail}`).join("\n")}` : "";
      ctx.ui.notify(`${header}\n\n${lastExplain}${traceBlock}`, "info");
    },
  });
}
