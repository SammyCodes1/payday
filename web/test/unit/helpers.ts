import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import type { EngineInput } from "@/lib/decision/engine";
import type { ChainState, RegistryEntry } from "@/lib/decision/types";
import { categoryToBytes32, normalizeRef } from "@/lib/ids";
import type { InvoiceExtraction } from "@/lib/invoice/schema";

export const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "invoices");
export const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

export const ADEBAYO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
export const PAPER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
export const CHIDI = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address;
export const POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const U = 1_000_000n;

export function registry(): RegistryEntry[] {
  return [
    {
      address: ADEBAYO, label: "Adebayo Properties", category: categoryToBytes32("RENT"), capUnits: 0n, allowedOnChain: true,
      identifiers: [normalizeRef("RC-1234567")], aliases: ["Adebayo Properties Ltd"], bankDetails: normalizeRef("GTBank 0123456789"),
      terms: { kind: "fixed", amount: "800.00", period: "month" },
    },
    {
      address: PAPER, label: "Lagos Paper Co", category: categoryToBytes32("SUPPLIES"), capUnits: 0n, allowedOnChain: true,
      identifiers: [normalizeRef("RC-7654321")], aliases: [], bankDetails: null, terms: { kind: "unit", unitPrice: "2.50", unit: "ream" },
    },
    {
      address: CHIDI, label: "Chidi Generator Repairs", category: categoryToBytes32("REPAIRS"), capUnits: 3000n * U, allowedOnChain: true,
      identifiers: [normalizeRef("TIN-55667788")], aliases: [],  bankDetails: null,
      terms: { kind: "milestones", items: [{ name: "Phase 1 diagnosis", amount: "300.00" }, { name: "Phase 2 overhaul", amount: "1450.00" }] },
    },
  ];
}

export function invoice(over: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    payeeName: "Adebayo Properties Ltd",
    payeeIdentifier: "RC-1234567",
    payeeBankDetails: "GTBank 0123456789",
    payeeWalletAddress: null,
    invoiceNumber: "INV-2026-0042",
    issueDate: "2026-10-01",
    dueDate: "2026-10-05",
    currency: "USDC",
    amount: "800.00",
    lineItems: [{ description: "Rent", quantity: "1", unitPrice: "800.00", total: "800.00" }],
    otherText: "",
    ...over,
  };
}

export function chain(over: Partial<ChainState> = {}): ChainState {
  return {
    chainId: 31337, policy: POLICY, paused: false, perPaymentCap: 1000n * U, monthlyCap: 5000n * U, spentInWindow: 0n,
    categoryBudget: 3000n * U, categorySpent: 0n, payeeSpent: 0n, globalCeiling: 20000n * U, totalPaid: 0n,
    balance: 10000n * U, paymentStatus: 0, ...over,
  };
}

export function baseInput(over: Partial<EngineInput> = {}): EngineInput {
  return {
    today: "2026-10-04",
    invoice: invoice(),
    extractionError: null,
    injection: [],
    match: null,
    amountUnits: 800n * U,
    chain: chain(),
    history: { paymentIdInDb: null, sameInvoiceNumber: [], sameAmountRecent: [], paidMilestones: [] },
    scheduledOutflowUnits: 0n,
    config: { scheduleLeadDays: 1, runwayBufferUnits: 0n, acceptedCurrencies: ["USD", "USDC"] },
    ownerAcknowledged: [],
    ...over,
  };
}
