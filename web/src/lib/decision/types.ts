import type { Address, Hex } from "viem";

export const DECISIONS = ["PAY_NOW", "SCHEDULE", "ASK", "ESCALATE", "REJECT"] as const;
export type Decision = (typeof DECISIONS)[number];
export const SEVERITY: Record<Decision, number> = { PAY_NOW: 0, SCHEDULE: 1, ASK: 2, ESCALATE: 3, REJECT: 4 };

export type ReasonCode =
  | "WITHIN_LIMITS"
  | "DUE_ON_RECEIPT"
  | "OVERDUE"
  | "DUE_LATER"
  | "EXTRACTION_INVALID"
  | "UNSUPPORTED_CURRENCY"
  | "ZERO_AMOUNT"
  | "INJECTION_SUSPECTED"
  | "PAYEE_UNKNOWN"
  | "PAYEE_AMBIGUOUS"
  | "PAYEE_NOT_ALLOWLISTED_ONCHAIN"
  | "PAYEE_DETAILS_CHANGED"
  | "PAYEE_NAME_MISMATCH"
  | "DUPLICATE_PAYMENT_ID"
  | "DUPLICATE_INVOICE"
  | "INVOICE_NUMBER_REUSED"
  | "POSSIBLE_DUPLICATE"
  | "NO_AGREED_TERMS"
  | "AMOUNT_NOT_AGREED"
  | "MILESTONE_ALREADY_PAID"
  | "LINE_ITEMS_MISMATCH"
  | "OVER_PER_PAYMENT_CAP"
  | "OVER_MONTHLY_REMAINING"
  | "OVER_CATEGORY_REMAINING"
  | "OVER_PAYEE_CAP"
  | "OVER_GLOBAL_CEILING"
  | "POLICY_PAUSED"
  | "INSUFFICIENT_BALANCE"
  | "RUNWAY_SHORTFALL"
  | "OWNER_CONFIRMED";

/** Detail values are restricted to canonical-JSON-safe primitives (amounts as decimal strings). */
export type Detail = Record<string, string | number | boolean | null>;

export interface Reason {
  code: ReasonCode;
  outcome: Decision;
  detail: Detail;
}

/** ASK reasons that the CONTRACT enforces by itself (it parks the payment as Pending). */
export const ONCHAIN_ASK_CODES: ReasonCode[] = [
  "OVER_PER_PAYMENT_CAP",
  "OVER_MONTHLY_REMAINING",
  "OVER_CATEGORY_REMAINING",
  "OVER_PAYEE_CAP",
];

export type AgreedTerms =
  | { kind: "fixed"; amount: string; period?: string }
  | { kind: "unit"; unitPrice: string; unit?: string }
  | { kind: "milestones"; items: { name: string; amount: string }[] };

/** One allow-listed payee: on-chain facts joined with the owner's app-side record. */
export interface RegistryEntry {
  address: Address; // from chain (PayeeSet events / getPayee), the ONLY source of payee addresses
  label: string; // on-chain label
  category: Hex; // on-chain bytes32
  capUnits: bigint; // on-chain per-payee cap (0 = none)
  allowedOnChain: boolean;
  identifiers: string[]; // owner-set: RC number, TIN, email ... (normalised with normalizeRef)
  aliases: string[]; // owner-set extra names
  bankDetails: string | null; // owner-set, normalised with normalizeRef
  terms: AgreedTerms | null;
}

export interface ChainState {
  chainId: number;
  policy: Address;
  paused: boolean;
  perPaymentCap: bigint;
  monthlyCap: bigint;
  spentInWindow: bigint;
  categoryBudget: bigint;
  categorySpent: bigint;
  payeeSpent: bigint;
  globalCeiling: bigint;
  totalPaid: bigint;
  balance: bigint;
  paymentStatus: number; // SpendPolicy.Status enum: 0 None,1 Pending,2 Executed,3 Rejected,4 Cancelled,5 Expired
}

export interface HistoryFacts {
  paymentIdInDb: string | null; // status of another invoice row with the same paymentId
  sameInvoiceNumber: { amountUnits: bigint; status: string }[]; // other rows, same payee + invoice no.
  sameAmountRecent: { invoiceNumber: string; daysAgo: number }[]; // other rows, same payee + amount, last 20 days
  paidMilestones: string[];
}

export interface EngineConfig {
  scheduleLeadDays: number;
  runwayBufferUnits: bigint;
  acceptedCurrencies: string[];
}

export interface DecisionResult {
  decision: Decision;
  reasons: Reason[];
  /** none: do nothing on chain. submit: call requestPayment now (it may come back Pending). */
  action: "none" | "submit";
  /** true when the only ASK reasons are contract-enforced caps (owner approves on chain). */
  onchainApproval: boolean;
  payOn: string | null; // YYYY-MM-DD for SCHEDULE
  matchedMilestone: string | null;
}

/** App-level ASK codes the owner may confirm in-app. Everything else needs a data fix or chain approval. */
export const ACKNOWLEDGEABLE_CODES: ReasonCode[] = [
  "NO_AGREED_TERMS",
  "LINE_ITEMS_MISMATCH",
  "POSSIBLE_DUPLICATE",
  "RUNWAY_SHORTFALL",
];
