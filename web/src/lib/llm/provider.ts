import "server-only";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { serverConfig } from "../config";
import { createMockExplainModel, createMockExtractionModel } from "../invoice/mock-model";

/**
 * Provider chosen by env: PAYDAY_LLM_PROVIDER = mock | openai | anthropic | google,
 * PAYDAY_LLM_MODEL = a model id that supports PDF/image input. Keys use each provider's
 * standard env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY).
 */
export function getModel(purpose: "extract" | "explain"): LanguageModel {
  const cfg = serverConfig();
  if (cfg.PAYDAY_LLM_PROVIDER === "mock") {
    return purpose === "extract" ? createMockExtractionModel() : createMockExplainModel();
  }
  if (!cfg.PAYDAY_LLM_MODEL) throw new Error("PAYDAY_LLM_MODEL is required for a real LLM provider");
  switch (cfg.PAYDAY_LLM_PROVIDER) {
    case "openai":
      return createOpenAI({})(cfg.PAYDAY_LLM_MODEL);
    case "anthropic":
      return createAnthropic({})(cfg.PAYDAY_LLM_MODEL);
    case "google":
      return createGoogleGenerativeAI({})(cfg.PAYDAY_LLM_MODEL);
  }
}
