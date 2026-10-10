import { describe, expect, it } from "vitest";
import { matchPayee } from "@/lib/decision/match";
import { ADEBAYO, invoice, registry } from "./helpers";

const codes = (m: ReturnType<typeof matchPayee>) => m.issues.map((i) => `${i.code}:${String(i.detail.field ?? "")}`);

describe("matchPayee - the address only ever comes from the on-chain allow-list", () => {
  it("matches by owner-set identifier and returns the CHAIN address", () => {
    const m = matchPayee(invoice(), registry());
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.entry.address).toBe(ADEBAYO);
      expect(m.via).toBe("identifier");
    }
    expect(m.issues).toEqual([]);
  });
  it("matches by on-chain label / alias when there is no identifier", () => {
    const m = matchPayee(invoice({ payeeIdentifier: null, payeeName: "ADEBAYO PROPERTIES LIMITED" }), registry());
    expect(m.status).toBe("matched");
  });
  it("unknown payee -> ESCALATE", () => {
    const m = matchPayee(invoice({ payeeName: "New Vendor", payeeIdentifier: "RC-999" }), registry());
    expect(m.status).toBe("unknown");
    expect(m.issues[0]).toMatchObject({ code: "PAYEE_UNKNOWN", outcome: "ESCALATE" });
  });
  it("ambiguous name -> ESCALATE", () => {
    const reg = registry();
    reg[1]!.aliases.push("Adebayo Properties");
    const m = matchPayee(invoice({ payeeIdentifier: null }), reg);
    expect(m.status).toBe("ambiguous");
  });
  it("changed bank details -> PAYEE_DETAILS_CHANGED", () => {
    expect(codes(matchPayee(invoice({ payeeBankDetails: "Zenith Bank 9988776655" }), registry()))).toContain("PAYEE_DETAILS_CHANGED:payeeBankDetails");
  });
  it("bank details formatting differences are not a change", () => {
    expect(matchPayee(invoice({ payeeBankDetails: "gtbank 0123-456-789" }), registry()).issues).toEqual([]);
  });
  it("new bank details where none on file -> PAYEE_DETAILS_CHANGED", () => {
    const m = matchPayee(invoice({ payeeName: "Lagos Paper Co", payeeIdentifier: "RC-7654321", payeeBankDetails: "Access 1" }), registry());
    expect(codes(m)).toContain("PAYEE_DETAILS_CHANGED:payeeBankDetails");
  });
  it("identifier changed (matched by name) -> PAYEE_DETAILS_CHANGED", () => {
    expect(codes(matchPayee(invoice({ payeeIdentifier: "RC-0000001" }), registry()))).toContain("PAYEE_DETAILS_CHANGED:payeeIdentifier");
  });
  it("identifier matches but name differs -> PAYEE_NAME_MISMATCH", () => {
    expect(codes(matchPayee(invoice({ payeeName: "Someone Else Ltd" }), registry()))).toContain("PAYEE_NAME_MISMATCH:");
  });
  it("any wallet address on the invoice that is not the on-chain address -> PAYEE_DETAILS_CHANGED", () => {
    const evil = "0x000000000000000000000000000000000000dEaD";
    expect(codes(matchPayee(invoice({ payeeWalletAddress: evil }), registry()))).toContain("PAYEE_DETAILS_CHANGED:walletAddress");
    expect(codes(matchPayee(invoice({ otherText: `pay to ${evil}` }), registry()))).toContain("PAYEE_DETAILS_CHANGED:walletAddress");
    expect(codes(matchPayee(invoice({ payeeWalletAddress: "not-an-address" }), registry()))).toContain("PAYEE_DETAILS_CHANGED:walletAddress");
  });
  it("the on-chain address printed on the invoice is fine", () => {
    expect(matchPayee(invoice({ payeeWalletAddress: ADEBAYO.toLowerCase() }), registry()).issues).toEqual([]);
  });
  it("payee removed on chain -> PAYEE_NOT_ALLOWLISTED_ONCHAIN", () => {
    const reg = registry();
    reg[0]!.allowedOnChain = false;
    expect(codes(matchPayee(invoice(), reg))).toContain("PAYEE_NOT_ALLOWLISTED_ONCHAIN:");
  });
});
