import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { canonicalJson } from "@/lib/canonical-json";
import { bytes32ToCategory, categoryToBytes32, computePaymentId, idempotencyKeyFor, normalizeRef, PAYMENT_ID_TAG, reasonHashOf } from "@/lib/ids";
import { formatUnits6, mulDecimal, toUnits } from "@/lib/money";
import { ADEBAYO, POLICY } from "./helpers";

describe("money", () => {
  it("converts exact decimals", () => {
    expect(toUnits("800")).toBe(800_000_000n);
    expect(toUnits("0.000001")).toBe(1n);
    expect(toUnits("1250.5")).toBe(1_250_500_000n);
    expect(formatUnits6(1_250_500_000n)).toBe("1250.5");
    expect(mulDecimal("40", "2.50")).toBe(100_000_000n);
    expect(mulDecimal("3", "0.333333")).toBe(999_999n);
  });
  it("rejects non-decimals", () => {
    expect(() => toUnits("1e3")).toThrow();
    expect(() => toUnits("-1")).toThrow();
    expect(() => toUnits("1.0000001")).toThrow();
  });
});

describe("canonical JSON", () => {
  it("sorts keys recursively and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });
  it("is key-order independent", () => {
    expect(canonicalJson({ a: 1, b: "x" })).toBe(canonicalJson({ b: "x", a: 1 }));
  });
  it("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ s: 'quote" and \n newline ü' })).toBe(JSON.stringify({ s: 'quote" and \n newline ü' }));
  });
  it("rejects undefined, bigint, non-safe numbers and NaN", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: 2 ** 60 })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
  });
  it("reasonHash = keccak256(utf8(canonical))", () => {
    const doc = { v: 1, decision: "PAY_NOW", reasons: [{ code: "WITHIN_LIMITS", outcome: "PAY_NOW", detail: {} }] };
    const { canonical, hash } = reasonHashOf(doc);
    expect(hash).toBe(keccak256(toBytes(canonical)));
    expect(reasonHashOf({ reasons: doc.reasons, decision: "PAY_NOW", v: 1 }).hash).toBe(hash);
    expect(reasonHashOf({ ...doc, decision: "ASK" }).hash).not.toBe(hash);
  });
});

describe("paymentId", () => {
  const base = { chainId: 31337, policy: POLICY, payee: ADEBAYO, amount: 800_000_000n, invoiceNumber: "INV-2026-0042" };
  it("matches the documented abi.encode layout", () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [keccak256(toBytes("PAYDAY_PAYMENT_ID_V1")), 31337n, POLICY, ADEBAYO, 800_000_000n, keccak256(toBytes("INV20260042"))],
      ),
    );
    expect(computePaymentId(base)).toBe(expected);
    expect(PAYMENT_ID_TAG).toBe(keccak256(toBytes("PAYDAY_PAYMENT_ID_V1")));
  });
  it("normalises invoice-number formatting so re-typed duplicates collide", () => {
    for (const n of ["inv 2026 0042", "INV/2026/0042", " INV-2026-0042 ", "ｉｎｖ-2026-0042"]) {
      expect(computePaymentId({ ...base, invoiceNumber: n })).toBe(computePaymentId(base));
    }
    expect(normalizeRef("INV-2026-0042")).toBe("INV20260042");
  });
  it("is sensitive to every encoded field", () => {
    const id = computePaymentId(base);
    expect(computePaymentId({ ...base, chainId: 5042002 })).not.toBe(id);
    expect(computePaymentId({ ...base, policy: ADEBAYO })).not.toBe(id);
    expect(computePaymentId({ ...base, payee: POLICY })).not.toBe(id);
    expect(computePaymentId({ ...base, amount: 800_000_001n })).not.toBe(id);
    expect(computePaymentId({ ...base, invoiceNumber: "INV-2026-0043" })).not.toBe(id);
  });
  it("refuses an invoice number that normalises to empty", () => {
    expect(() => computePaymentId({ ...base, invoiceNumber: "---" })).toThrow();
  });
});

describe("misc ids", () => {
  it("category bytes32 round-trips like cast format-bytes32-string", () => {
    expect(categoryToBytes32("RENT")).toBe("0x52454e5400000000000000000000000000000000000000000000000000000000");
    expect(bytes32ToCategory(categoryToBytes32("SUPPLIES"))).toBe("SUPPLIES");
  });
  it("idempotency keys are deterministic UUIDs", () => {
    const id = computePaymentId({ chainId: 1, policy: POLICY, payee: ADEBAYO, amount: 1n, invoiceNumber: "A1" });
    const k = idempotencyKeyFor("requestPayment", id);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKeyFor("requestPayment", id)).toBe(k);
    expect(idempotencyKeyFor("approvePendingWithSig", id, "7")).not.toBe(k);
  });
});

describe("audit-fix encodings (L-01, L-04, I-05)", () => {
  it("invoiceKey ignores the amount and normalises the invoice number, but binds payee/policy/chain", async () => {
    const { computeInvoiceKey, INVOICE_KEY_TAG } = await import("@/lib/ids");
    const k = computeInvoiceKey({ chainId: 5042002, policy: POLICY, payee: ADEBAYO, invoiceNumber: "inv/2026-0042" });
    expect(k).toBe(computeInvoiceKey({ chainId: 5042002, policy: POLICY, payee: ADEBAYO, invoiceNumber: "INV 2026 0042" }));
    expect(k).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
          [INVOICE_KEY_TAG, 5042002n, POLICY, ADEBAYO, keccak256(toBytes("INV20260042"))],
        ),
      ),
    );
    expect(k).not.toBe(computeInvoiceKey({ chainId: 5042, policy: POLICY, payee: ADEBAYO, invoiceNumber: "INV20260042" }));
    expect(() => computeInvoiceKey({ chainId: 1, policy: POLICY, payee: ADEBAYO, invoiceNumber: "--" })).toThrow();
  });
  it("EIP-712 type string matches SpendPolicy.APPROVE_TYPEHASH fields", async () => {
    const { APPROVE_TYPES, APPROVE_TYPE_STRING } = await import("@/lib/eip712");
    const built = `ApprovePending(${APPROVE_TYPES.ApprovePending.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(built).toBe(APPROVE_TYPE_STRING);
    const { spendPolicyAbi } = await import("@/lib/abi");
    expect(spendPolicyAbi.some((e) => e.type === "function" && e.name === "approvalDigest")).toBe(true);
    expect(spendPolicyAbi.some((e) => e.type === "function" && (e.name as string) === "cancelPending")).toBe(false);
  });
});
