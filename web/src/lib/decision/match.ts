import { getAddress, isAddress, type Address } from "viem";
import type { InvoiceExtraction } from "../invoice/schema";
import { normalizeName, normalizeRef } from "../ids";
import type { Reason, RegistryEntry } from "./types";

export type PayeeMatch =
  | { status: "matched"; entry: RegistryEntry; via: "identifier" | "name"; issues: Reason[] }
  | { status: "unknown"; issues: Reason[] }
  | { status: "ambiguous"; issues: Reason[] };

const ADDR_RE = /0x[0-9a-fA-F]{40}\b/g;

/**
 * Match the invoice to an allow-listed payee by the OWNER-SET identifier or label/alias.
 * The returned address is always `entry.address` (from chain). Any payee detail on the
 * invoice that is new or different from what the owner stored -> ESCALATE.
 */
export function matchPayee(inv: InvoiceExtraction, registry: RegistryEntry[]): PayeeMatch {
  const id = inv.payeeIdentifier ? normalizeRef(inv.payeeIdentifier) : "";
  const name = normalizeName(inv.payeeName);
  const nameMatches = (e: RegistryEntry) =>
    !!name && [e.label, ...e.aliases].some((n) => normalizeName(n) === name);

  const byId = id ? registry.filter((e) => e.identifiers.includes(id)) : [];
  const byName = registry.filter(nameMatches);
  const candidates = byId.length ? byId : byName;
  const via = byId.length ? "identifier" : "name";

  if (candidates.length === 0) {
    return {
      status: "unknown",
      issues: [
        {
          code: "PAYEE_UNKNOWN",
          outcome: "ESCALATE",
          detail: { payeeName: inv.payeeName, payeeIdentifier: inv.payeeIdentifier },
        },
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      issues: [{ code: "PAYEE_AMBIGUOUS", outcome: "ESCALATE", detail: { candidates: candidates.length } }],
    };
  }

  const entry = candidates[0]!;
  const issues: Reason[] = [];

  if (!entry.allowedOnChain) {
    issues.push({ code: "PAYEE_NOT_ALLOWLISTED_ONCHAIN", outcome: "ESCALATE", detail: { payee: entry.address } });
  }
  if (via === "identifier" && !nameMatches(entry)) {
    issues.push({
      code: "PAYEE_NAME_MISMATCH",
      outcome: "ESCALATE",
      detail: { invoiceName: inv.payeeName, label: entry.label },
    });
  }
  if (via === "name" && id && !entry.identifiers.includes(id)) {
    issues.push({
      code: "PAYEE_DETAILS_CHANGED",
      outcome: "ESCALATE",
      detail: { field: "payeeIdentifier", invoiceValue: inv.payeeIdentifier, onFile: entry.identifiers.length > 0 },
    });
  }
  if (inv.payeeBankDetails) {
    const bank = normalizeRef(inv.payeeBankDetails);
    if (!entry.bankDetails || bank !== entry.bankDetails) {
      issues.push({
        code: "PAYEE_DETAILS_CHANGED",
        outcome: "ESCALATE",
        detail: { field: "payeeBankDetails", invoiceValue: inv.payeeBankDetails, onFile: !!entry.bankDetails },
      });
    }
  }
  // Any wallet address anywhere on the invoice must equal the on-chain payee address.
  const addresses = new Set<string>();
  for (const text of [inv.payeeWalletAddress ?? "", inv.otherText, inv.payeeName]) {
    for (const m of text.matchAll(ADDR_RE)) addresses.add(m[0]);
  }
  if (inv.payeeWalletAddress && !isAddress(inv.payeeWalletAddress.trim())) addresses.add(inv.payeeWalletAddress.trim());
  for (const a of addresses) {
    const same = isAddress(a) && (getAddress(a) as Address) === entry.address;
    if (!same) {
      issues.push({
        code: "PAYEE_DETAILS_CHANGED",
        outcome: "ESCALATE",
        detail: { field: "walletAddress", invoiceValue: a, onFile: true },
      });
    }
  }
  return { status: "matched", entry, via, issues };
}
