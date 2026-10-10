import { describe, expect, it } from "vitest";
import { validateExtraction } from "@/lib/invoice/schema";
import { invoice } from "./helpers";

describe("InvoiceExtraction (zod, strict)", () => {
  it("accepts a well-formed extraction", () => {
    expect(validateExtraction(invoice()).ok).toBe(true);
  });
  it.each([
    ["float amount", { amount: 800.5 }],
    ["amount with symbol", { amount: "$800.00" }],
    ["thousands separator", { amount: "1,250.00" }],
    ["7 decimals", { amount: "1.0000001" }],
    ["impossible date", { dueDate: "2026-02-30" }],
    ["non-ISO date", { dueDate: "05/10/2026" }],
    ["lower-case currency", { currency: "usdc" }],
    ["empty invoice number", { invoiceNumber: "" }],
    ["empty payee", { payeeName: "" }],
    ["too many line items", { lineItems: Array.from({ length: 51 }, () => ({ description: "x", quantity: "1", unitPrice: "1", total: "1" })) }],
    ["bad line item", { lineItems: [{ description: "x", quantity: "one", unitPrice: "1", total: "1" }] }],
    ["over-long otherText", { otherText: "a".repeat(4001) }],
  ])("rejects %s", (_n, over) => {
    expect(validateExtraction({ ...invoice(), ...over }).ok).toBe(false);
  });
  it("rejects unknown keys (strict) - e.g. a model trying to add a payTo field", () => {
    const r = validateExtraction({ ...invoice(), payTo: "0x000000000000000000000000000000000000dEaD" });
    expect(r.ok).toBe(false);
  });
  it("rejects missing required keys", () => {
    const rest: Partial<ReturnType<typeof invoice>> = invoice();
    delete rest.otherText;
    expect(validateExtraction(rest).ok).toBe(false);
  });
  it("reports field paths in errors", () => {
    const r = validateExtraction({ ...invoice(), amount: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^amount:/);
  });
});
