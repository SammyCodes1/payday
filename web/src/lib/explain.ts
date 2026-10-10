import "server-only";
import { generateText } from "ai";
import { getModel } from "./llm/provider";
import type { DecisionResult } from "./decision/types";

/**
 * Human-readable explanation. ADVISORY ONLY: the text is stored next to the decision but is
 * never parsed, never hashed into reasonHash, and cannot change the decision or the action.
 * The model sees only the engine's structured output, not the raw invoice text.
 */
export async function explainDecision(result: DecisionResult): Promise<string> {
  const fallback = `Decision ${result.decision}: ${result.reasons.map((r) => r.code).join(", ")}.`;
  try {
    const res = await generateText({
      model: getModel("explain"),
      system:
        "You write a 2-4 sentence plain-English explanation of an accounts-payable decision for a small-business owner. " +
        "The decision is final and was made by deterministic rules; you cannot change it and must not suggest overriding it.",
      prompt: JSON.stringify({ decision: result.decision, reasons: result.reasons }),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(20_000),
    });
    return res.text.slice(0, 1500) || fallback;
  } catch {
    return fallback;
  }
}
