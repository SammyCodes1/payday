import { describe, expect, it } from "vitest";
import { extractInvoice, EXTRACTION_SYSTEM_PROMPT } from "@/lib/invoice/extract";
import { createMockExtractionModel } from "@/lib/invoice/mock-model";
import { extractPdfText } from "@/lib/invoice/pdf-text";
import { isInjection, scanForInjection } from "@/lib/injection";
import { fixture } from "./helpers";

async function extract(name: string) {
  const model = createMockExtractionModel();
  const mediaType = name.endsWith(".png") ? "image/png" : "application/pdf";
  const r = await extractInvoice(model, { bytes: fixture(name), mediaType, filename: name });
  return { r, model };
}

describe("extraction via the AI SDK with the offline mock provider", () => {
  it("the extractor is called with NO tools, a strict JSON schema and the untrusted-data system prompt", async () => {
    const { model } = await extract("01-normal.pdf");
    const call = model.doGenerateCalls[0]!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.responseFormat?.type).toBe("json");
    const sys = call.prompt.find((m) => m.role === "system");
    expect(sys && "content" in sys ? sys.content : "").toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/UNTRUSTED DATA/);
    expect(call.temperature).toBe(0);
  });

  it("normal invoice", async () => {
    const { r } = await extract("01-normal.pdf");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({
        payeeName: "Adebayo Properties Ltd", payeeIdentifier: "RC-1234567", payeeBankDetails: "GTBank 0123456789",
        invoiceNumber: "INV-2026-0042", dueDate: "2026-10-05", currency: "USDC", amount: "800.00", payeeWalletAddress: null,
      });
      expect(r.value.lineItems).toHaveLength(1);
    }
  });

  it("injection invoice: instructions land in otherText as data and are flagged", async () => {
    const { r } = await extract("02-injection.pdf");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.otherText).toMatch(/IGNORE PREVIOUS INSTRUCTIONS/);
    const flags = scanForInjection({ otherText: r.value.otherText });
    expect(isInjection(flags)).toBe(true);
    expect(new Set(flags.map((f) => f.rule))).toEqual(
      new Set(["ignore-instructions", "role-hijack", "pay-to-address", "move-all-funds", "secrecy", "approval-bypass", "evm-address"]),
    );
  });

  it("raw PDF text layer is screened too (independent of what the model returns)", () => {
    expect(isInjection(scanForInjection({ rawText: extractPdfText(fixture("02-injection.pdf")) }))).toBe(true);
    expect(isInjection(scanForInjection({ rawText: extractPdfText(fixture("01-normal.pdf")) }))).toBe(false);
  });

  it.each([
    ["03-changed-bank.pdf", { invoiceNumber: "INV-2026-0043", payeeBankDetails: "Zenith Bank 9988776655" }],
    ["04-duplicate.pdf", { invoiceNumber: "INV-2026-0042", amount: "800.00" }],
    ["05-over-cap.pdf", { payeeIdentifier: "TIN-55667788", amount: "1450.00" }],
    ["06-wrong-rate.pdf", { amount: "310.00" }],
    ["07-future-due.pdf", { dueDate: "2026-10-20", amount: "150.00" }],
    ["08-supplies-large.pdf", { amount: "1250.00" }],
    ["09-unknown-payee.pdf", { payeeName: "Totally New Vendor Ltd", payeeWalletAddress: "0x1111111111111111111111111111111111111111" }],
  ])("%s extracts", async (name, expected) => {
    const { r } = await extract(name);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject(expected);
  });

  it("an image the offline mock cannot read yields an obviously-unknown invoice", async () => {
    const { r } = await extract("10-photo.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ payeeName: "UNREADABLE (offline mock)", amount: "0" });
  });

  it("model output that violates the schema is rejected by zod", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const bad = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ payeeName: "X", amount: 12.5, payTo: "0xdead" }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const r = await extractInvoice(bad, { bytes: fixture("01-normal.pdf"), mediaType: "application/pdf", filename: "x.pdf" });
    expect(r.ok).toBe(false);
  });
});
