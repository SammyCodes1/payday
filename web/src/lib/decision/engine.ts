import type { InvoiceExtraction } from "../invoice/schema";
import type { InjectionFlag } from "../injection";
import { isInjection } from "../injection";
import { formatUnits6, mulDecimal, toUnits } from "../money";
import type { PayeeMatch } from "./match";
import {
  ACKNOWLEDGEABLE_CODES,
  ONCHAIN_ASK_CODES,
  SEVERITY,
  type ChainState,
  type Decision,
  type DecisionResult,
  type EngineConfig,
  type HistoryFacts,
  type Reason,
  type ReasonCode,
} from "./types";

export const ENGINE_VERSION = "payday-decision-v1";

export interface EngineInput {
  today: string; // YYYY-MM-DD (UTC), from the injectable clock
  invoice: InvoiceExtraction | null;
  extractionError: string | null;
  injection: InjectionFlag[];
  match: PayeeMatch | null;
  amountUnits: bigint | null;
  chain: ChainState | null;
  history: HistoryFacts;
  scheduledOutflowUnits: bigint; // other committed bills (scheduled / awaiting / pending) next 30 days
  config: EngineConfig;
  /** ASK codes the owner explicitly confirmed in-app (never covers ESCALATE/REJECT or contract caps). */
  ownerAcknowledged: ReasonCode[];
}

const usd = (u: bigint) => formatUnits6(u);
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function amountChecks(inv: InvoiceExtraction, amount: bigint, m: PayeeMatch & { status: "matched" }, h: HistoryFacts) {
  const out: Reason[] = [];
  let milestone: string | null = null;

  if (inv.lineItems.length > 0) {
    let sum = 0n;
    for (const li of inv.lineItems) sum += toUnits(li.total);
    const bad = inv.lineItems.find((li) => mulDecimal(li.quantity, li.unitPrice) !== toUnits(li.total));
    if (sum !== amount || bad) {
      out.push({
        code: "LINE_ITEMS_MISMATCH",
        outcome: "ASK",
        detail: { lineItemsSum: usd(sum), amount: usd(amount), badLine: bad ? bad.description : null },
      });
    }
  }

  const t = m.entry.terms;
  if (!t) {
    out.push({ code: "NO_AGREED_TERMS", outcome: "ASK", detail: { payee: m.entry.label } });
    return { reasons: out, milestone };
  }
  if (t.kind === "fixed") {
    if (toUnits(t.amount) !== amount) {
      out.push({ code: "AMOUNT_NOT_AGREED", outcome: "ESCALATE", detail: { kind: "fixed", agreed: t.amount, invoiced: usd(amount) } });
    }
  } else if (t.kind === "unit") {
    const agreed = toUnits(t.unitPrice);
    const off = inv.lineItems.find((li) => toUnits(li.unitPrice) !== agreed);
    if (inv.lineItems.length === 0 || off) {
      out.push({
        code: "AMOUNT_NOT_AGREED",
        outcome: "ESCALATE",
        detail: { kind: "unit", agreedUnitPrice: t.unitPrice, invoicedUnitPrice: off ? off.unitPrice : null },
      });
    }
  } else {
    const same = t.items.filter((i) => toUnits(i.amount) === amount);
    const unpaid = same.find((i) => !h.paidMilestones.includes(i.name));
    if (unpaid) milestone = unpaid.name;
    else if (same.length > 0) {
      out.push({ code: "MILESTONE_ALREADY_PAID", outcome: "ESCALATE", detail: { milestone: same[0]!.name } });
    } else {
      out.push({ code: "AMOUNT_NOT_AGREED", outcome: "ESCALATE", detail: { kind: "milestones", invoiced: usd(amount) } });
    }
  }
  return { reasons: out, milestone };
}

/**
 * Pure, deterministic decision. Every finding becomes a Reason with its own outcome; the final
 * decision is the most severe outcome. The LLM never sees this function's inputs as instructions
 * and cannot change its output.
 */
export function decide(input: EngineInput): DecisionResult {
  const reasons: Reason[] = [];
  const { invoice: inv, chain, match, history: h } = input;
  let payOn: string | null = null;
  let milestone: string | null = null;

  if (!inv) {
    reasons.push({ code: "EXTRACTION_INVALID", outcome: "ASK", detail: { error: (input.extractionError ?? "unknown").slice(0, 500) } });
    return finish(reasons, input, null, null, chain);
  }

  if (isInjection(input.injection)) {
    reasons.push({
      code: "INJECTION_SUSPECTED",
      outcome: "ESCALATE",
      detail: {
        rules: [...new Set(input.injection.filter((f) => f.rule !== "evm-address").map((f) => f.rule))].sort().join(","),
        count: input.injection.length,
      },
    });
  }
  if (!input.config.acceptedCurrencies.includes(inv.currency)) {
    reasons.push({ code: "UNSUPPORTED_CURRENCY", outcome: "ASK", detail: { currency: inv.currency } });
  }
  const amount = input.amountUnits;
  if (amount === null || amount === 0n) {
    reasons.push({ code: "ZERO_AMOUNT", outcome: "REJECT", detail: { amount: inv.amount } });
  }

  if (!match) {
    reasons.push({ code: "PAYEE_UNKNOWN", outcome: "ESCALATE", detail: { payeeName: inv.payeeName } });
  } else {
    reasons.push(...match.issues);
  }

  if (match?.status === "matched" && amount && amount > 0n) {
    // ---- duplicates
    if ((chain && chain.paymentStatus !== 0) || h.paymentIdInDb) {
      reasons.push({
        code: "DUPLICATE_PAYMENT_ID",
        outcome: "REJECT",
        detail: { chainStatus: chain?.paymentStatus ?? null, appStatus: h.paymentIdInDb },
      });
    }
    for (const prev of h.sameInvoiceNumber) {
      if (prev.status === "REJECTED" || prev.status === "DISMISSED") continue;
      const neverPaid = prev.status === "ESCALATED" || prev.status === "FAILED" || prev.status === "EXTRACTION_FAILED";
      if (prev.amountUnits === amount && neverPaid) {
        // e.g. a corrected re-send of an invoice that was escalated: owner must confirm it is not a double bill
        reasons.push({ code: "POSSIBLE_DUPLICATE", outcome: "ASK", detail: { invoiceNumber: inv.invoiceNumber, previousStatus: prev.status } });
      } else if (prev.amountUnits === amount) {
        reasons.push({ code: "DUPLICATE_INVOICE", outcome: "REJECT", detail: { invoiceNumber: inv.invoiceNumber, previousStatus: prev.status } });
      } else {
        reasons.push({
          code: "INVOICE_NUMBER_REUSED",
          outcome: "ESCALATE",
          detail: { invoiceNumber: inv.invoiceNumber, previousAmount: usd(prev.amountUnits), amount: usd(amount) },
        });
      }
    }
    if (h.sameAmountRecent.length > 0) {
      reasons.push({
        code: "POSSIBLE_DUPLICATE",
        outcome: "ASK",
        detail: { otherInvoice: h.sameAmountRecent[0]!.invoiceNumber, daysAgo: h.sameAmountRecent[0]!.daysAgo },
      });
    }

    // ---- agreed rate / milestone
    const a = amountChecks(inv, amount, match, h);
    reasons.push(...a.reasons);
    milestone = a.milestone;

    // ---- contract state (read live from chain)
    if (chain) {
      if (chain.totalPaid + amount > chain.globalCeiling) {
        reasons.push({
          code: "OVER_GLOBAL_CEILING",
          outcome: "REJECT",
          detail: { remaining: usd(chain.globalCeiling > chain.totalPaid ? chain.globalCeiling - chain.totalPaid : 0n), amount: usd(amount) },
        });
      }
      if (chain.paused) reasons.push({ code: "POLICY_PAUSED", outcome: "ASK", detail: {} });
      if (chain.balance < amount) {
        reasons.push({ code: "INSUFFICIENT_BALANCE", outcome: "ASK", detail: { balance: usd(chain.balance), amount: usd(amount) } });
      } else if (chain.balance - amount < input.scheduledOutflowUnits + input.config.runwayBufferUnits) {
        reasons.push({
          code: "RUNWAY_SHORTFALL",
          outcome: "ASK",
          detail: {
            balanceAfter: usd(chain.balance - amount),
            committedNext30d: usd(input.scheduledOutflowUnits),
            buffer: usd(input.config.runwayBufferUnits),
          },
        });
      }
      const rem = (cap: bigint, spent: bigint) => (cap > spent ? cap - spent : 0n);
      if (amount > chain.perPaymentCap) {
        reasons.push({ code: "OVER_PER_PAYMENT_CAP", outcome: "ASK", detail: { cap: usd(chain.perPaymentCap), amount: usd(amount) } });
      }
      if (amount > rem(chain.monthlyCap, chain.spentInWindow)) {
        reasons.push({ code: "OVER_MONTHLY_REMAINING", outcome: "ASK", detail: { remaining: usd(rem(chain.monthlyCap, chain.spentInWindow)), amount: usd(amount) } });
      }
      if (amount > rem(chain.categoryBudget, chain.categorySpent)) {
        reasons.push({ code: "OVER_CATEGORY_REMAINING", outcome: "ASK", detail: { remaining: usd(rem(chain.categoryBudget, chain.categorySpent)), amount: usd(amount) } });
      }
      if (match.entry.capUnits > 0n && amount > rem(match.entry.capUnits, chain.payeeSpent)) {
        reasons.push({ code: "OVER_PAYEE_CAP", outcome: "ASK", detail: { remaining: usd(rem(match.entry.capUnits, chain.payeeSpent)), amount: usd(amount) } });
      }
    }

    // ---- due date
    if (!inv.dueDate) {
      reasons.push({ code: "DUE_ON_RECEIPT", outcome: "PAY_NOW", detail: {} });
    } else {
      const pay = addDays(inv.dueDate, -input.config.scheduleLeadDays);
      const d = dayDiff(pay, input.today);
      if (d > 0) {
        payOn = pay;
        reasons.push({ code: "DUE_LATER", outcome: "SCHEDULE", detail: { dueDate: inv.dueDate, payOn: pay } });
      } else if (dayDiff(inv.dueDate, input.today) < 0) {
        reasons.push({ code: "OVERDUE", outcome: "PAY_NOW", detail: { dueDate: inv.dueDate, daysLate: -dayDiff(inv.dueDate, input.today) } });
      }
    }
  }
  return finish(reasons, input, payOn, milestone, chain);
}

function finish(
  reasons: Reason[],
  input: EngineInput,
  payOn: string | null,
  milestone: string | null,
  chain: ChainState | null,
): DecisionResult {
  // Owner in-app confirmation downgrades app-level ASK reasons only.
  const acked = new Set(input.ownerAcknowledged.filter((c) => ACKNOWLEDGEABLE_CODES.includes(c)));
  const adjusted = reasons.map((r) =>
    r.outcome === "ASK" && acked.has(r.code) ? { ...r, outcome: "PAY_NOW" as Decision } : r,
  );
  if (acked.size > 0) {
    adjusted.push({ code: "OWNER_CONFIRMED", outcome: "PAY_NOW", detail: { codes: [...acked].sort().join(",") } });
  }
  if (!adjusted.some((r) => SEVERITY[r.outcome] > SEVERITY.PAY_NOW) && chain && input.invoice) {
    adjusted.push({ code: "WITHIN_LIMITS", outcome: "PAY_NOW", detail: {} });
  }
  const decision = adjusted.reduce<Decision>((acc, r) => (SEVERITY[r.outcome] > SEVERITY[acc] ? r.outcome : acc), "PAY_NOW");

  const asks = adjusted.filter((r) => r.outcome === "ASK");
  const onchainApproval = decision === "ASK" && asks.length > 0 && asks.every((r) => ONCHAIN_ASK_CODES.includes(r.code));
  // A payment that will be parked on chain anyway is submitted now (even if it is also due later),
  // so the owner sees and approves it in one place.
  const action: DecisionResult["action"] = decision === "PAY_NOW" || onchainApproval ? "submit" : "none";
  return {
    decision,
    reasons: adjusted,
    action,
    onchainApproval,
    payOn: decision === "SCHEDULE" ? payOn : null,
    matchedMilestone: milestone,
  };
}
