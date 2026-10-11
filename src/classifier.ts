import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readKey, type Config } from "./config.ts";
import { heuristic, redact, type Verdict } from "./routing.ts";
import questionFile from "./questions.json";

const questions = {
  task: { ...questionFile.task, type: "choice" as const },
  difficulty: { ...questionFile.difficulty, type: "score" as const, criteria: questionFile.difficulty.criteria as [string, string, ...string[]] },
  needs_reasoning: { ...questionFile.needs_reasoning, type: "noul" as const },
  needs_vision: { ...questionFile.needs_vision, type: "noul" as const },
  long_horizon: { ...questionFile.long_horizon, type: "noul" as const },
};

export async function classify(prompt: string, hasImage: boolean, cfg: Config, ctx: ExtensionContext, agentDir: string, signal: AbortSignal): Promise<Verdict> {
  const safePrompt = redact(prompt).slice(0, cfg.jev.promptChars);
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider("typesafe", ctx.sessionManager.getSessionId(), { signal }) ?? readKey(agentDir, cfg);
    if (!key) throw new Error("No TypeSafe credential; using local heuristic");
    const model = ctx.modelRegistry.find("typesafe", cfg.jev.model);
    const judge = new TypeSafeJudge({
      apiKey: key, model: cfg.jev.model,
      baseUrl: model?.baseUrl ?? ctx.modelRegistry.getProviderBaseUrl("typesafe"),
      headers: model ? await ctx.modelRegistry.resolveModelHeaders(model, signal) : await ctx.modelRegistry.getProviderHeaders("typesafe"),
      timeoutMs: cfg.jev.timeoutMs,
    });
    const result = await judge.judge({ state: { prompt: safePrompt, has_image: hasImage }, questions }, { signal });
    const a = result.answers;
    if (a.task.type !== "choice" || a.difficulty.type !== "score" || a.needs_reasoning.type !== "noul" || a.needs_vision.type !== "noul" || a.long_horizon.type !== "noul") throw new Error("Invalid Jev answer types");
    const values = [a.difficulty.score, a.task.confidence, a.difficulty.confidence, a.needs_reasoning.noul, a.needs_vision.noul, a.long_horizon.noul];
    if (values.some(v => !Number.isFinite(v)) || !(a.task.choice in questions.task.criteria)) throw new Error("Invalid Jev answer values");
    return {
      task: a.task.choice, difficulty: Math.min(4, Math.max(0, Math.round(a.difficulty.score))),
      needsReasoning: a.needs_reasoning.noul >= 0.5, needsVision: hasImage || a.needs_vision.noul >= 0.5,
      longHorizon: a.long_horizon.noul >= 0.5,
      confidence: Math.min(1, Math.max(0, (a.task.confidence + a.difficulty.confidence) / 2)), source: "jev",
    };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    // Never echo provider error bodies: they can contain the submitted prompt or credentials.
    const reason = error instanceof Error && error.message.startsWith("No TypeSafe") ? error.message : "Jev unavailable or invalid response; using local heuristic";
    return { ...heuristic(safePrompt, hasImage), error: reason };
  }
}
