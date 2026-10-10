import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { extractPdfText } from "./pdf-text";

/**
 * Offline, deterministic stand-in for the extraction LLM (tests + offline dev).
 * It reads "Key: Value" lines from the PDF text layer. Like the real model it only RETURNS
 * DATA - it has no tools and ignores any instructions inside the document.
 */
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function result(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  } as LanguageModelV4GenerateResult;
}

function fileBytes(opts: LanguageModelV4CallOptions): { bytes: Uint8Array; mediaType: string } | null {
  for (const msg of opts.prompt) {
    if (msg.role !== "user") continue;
    for (const part of msg.content) {
      if (part.type !== "file") continue;
      const d = part.data as { type: string; data?: Uint8Array | string };
      if (d.type !== "data" || d.data === undefined) continue;
      const bytes = typeof d.data === "string" ? Uint8Array.from(Buffer.from(d.data, "base64")) : d.data;
      return { bytes, mediaType: part.mediaType };
    }
  }
  return null;
}

export function parseInvoiceText(text: string) {
  const out = {
    payeeName: "",
    payeeIdentifier: null as string | null,
    payeeBankDetails: null as string | null,
    payeeWalletAddress: null as string | null,
    invoiceNumber: "",
    issueDate: null as string | null,
    dueDate: null as string | null,
    currency: "",
    amount: "",
    lineItems: [] as { description: string; quantity: string; unitPrice: string; total: string }[],
    otherText: "",
  };
  const other: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    const key = kv?.[1]?.trim().toLowerCase();
    const val = kv?.[2]?.trim() ?? "";
    switch (key) {
      case "from":
        out.payeeName = val;
        break;
      case "vendor id":
        out.payeeIdentifier = val || null;
        break;
      case "bank details":
        out.payeeBankDetails = val || null;
        break;
      case "wallet":
        out.payeeWalletAddress = val || null;
        break;
      case "invoice number":
        out.invoiceNumber = val;
        break;
      case "issue date":
        out.issueDate = val || null;
        break;
      case "due date":
        out.dueDate = val || null;
        break;
      case "currency":
        out.currency = val.toUpperCase();
        break;
      case "amount due":
        out.amount = val.replace(/,/g, "");
        break;
      case "item": {
        const [description, quantity, unitPrice, total] = val.split("|").map((s) => s.trim().replace(/,/g, ""));
        out.lineItems.push({
          description: description ?? "",
          quantity: quantity ?? "",
          unitPrice: unitPrice ?? "",
          total: total ?? "",
        });
        break;
      }
      default:
        other.push(line);
    }
  }
  out.otherText = other.join("\n");
  return out;
}

export function createMockExtractionModel() {
  return new MockLanguageModelV4({
    provider: "payday-mock",
    modelId: "mock-extractor",
    doGenerate: async (opts) => {
      const file = fileBytes(opts);
      if (!file) return result(JSON.stringify({ error: "no file" }));
      const text = file.mediaType === "application/pdf" ? extractPdfText(file.bytes) : "";
      if (!text) {
        // Images can't be read offline: return a clearly-unknown invoice -> engine escalates/asks.
        return result(
          JSON.stringify({
            ...parseInvoiceText(""),
            payeeName: "UNREADABLE (offline mock)",
            invoiceNumber: "UNKNOWN",
            currency: "USDC",
            amount: "0",
            otherText: "Offline mock cannot read images. Set PAYDAY_LLM_PROVIDER for real extraction.",
          }),
        );
      }
      return result(JSON.stringify(parseInvoiceText(text)));
    },
  });
}

export function createMockExplainModel() {
  return new MockLanguageModelV4({
    provider: "payday-mock",
    modelId: "mock-explainer",
    doGenerate: async (opts) => {
      const last = opts.prompt.at(-1);
      const text =
        last && last.role === "user"
          ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
          : "";
      const decision = /"decision":"([A-Z_]+)"/.exec(text)?.[1] ?? "UNKNOWN";
      const codes = [...text.matchAll(/"code":"([A-Z_]+)"/g)].map((m) => m[1]).join(", ");
      return result(`Offline summary: the policy engine decided ${decision} because of: ${codes || "no findings"}.`);
    },
  });
}
