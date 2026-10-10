import "server-only";
import { getAddress, type Address } from "viem";
import { readPayee } from "./chain";
import { getDb } from "./db";
import { currentPolicyEvents, payeesFromEvents } from "./events";
import { normalizeRef } from "./ids";
import type { AgreedTerms, RegistryEntry } from "./decision/types";
import { z } from "zod";
import { DecimalString } from "./invoice/schema";
import { activePolicy } from "./tenant";

export const AgreedTermsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amount: DecimalString, period: z.string().max(40).optional() }).strict(),
  z.object({ kind: z.literal("unit"), unitPrice: DecimalString, unit: z.string().max(40).optional() }).strict(),
  z
    .object({
      kind: z.literal("milestones"),
      items: z.array(z.object({ name: z.string().min(1).max(100), amount: DecimalString }).strict()).min(1).max(50),
    })
    .strict(),
]);

/** Owner-set, app-side payee record. The ADDRESS key must already be allow-listed on chain. */
export const PayeeRecordInput = z
  .object({
    address: z.string(),
    identifiers: z.array(z.string().min(1).max(100)).max(10),
    aliases: z.array(z.string().min(1).max(200)).max(10),
    bankDetails: z.string().max(200).nullable(),
    terms: AgreedTermsSchema.nullable(),
  })
  .strict();

interface PayeeRow {
  address: string;
  identifiers_json: string;
  aliases_json: string;
  bank_details: string | null;
  terms_json: string | null;
}

export function savePayeeRecord(input: z.infer<typeof PayeeRecordInput>, by: Address) {
  const address = getAddress(input.address);
  getDb()
    .prepare(
      `INSERT INTO payee_terms (policy_address, address, identifiers_json, aliases_json, bank_details, terms_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(policy_address, address) DO UPDATE SET identifiers_json=excluded.identifiers_json, aliases_json=excluded.aliases_json,
         bank_details=excluded.bank_details, terms_json=excluded.terms_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    )
    .run(
      activePolicy(),
      address,
      JSON.stringify(input.identifiers.map(normalizeRef).filter(Boolean)),
      JSON.stringify(input.aliases),
      input.bankDetails ? normalizeRef(input.bankDetails) : null,
      input.terms ? JSON.stringify(input.terms) : null,
      new Date().toISOString(),
      by,
    );
}

/** Join on-chain allow-list (events + live getPayee) with the owner's app-side records. */
export async function loadRegistry(): Promise<RegistryEntry[]> {
  const onchain = payeesFromEvents(await currentPolicyEvents());
  const rows = getDb().prepare("SELECT * FROM payee_terms WHERE policy_address = ?").all(activePolicy()) as unknown as PayeeRow[];
  const byAddr = new Map(rows.map((r) => [getAddress(r.address), r]));
  const out: RegistryEntry[] = [];
  for (const p of onchain) {
    const live = await readPayee(p.address); // events can lag; the live struct is authoritative
    const r = byAddr.get(p.address);
    out.push({
      address: p.address,
      label: live.label,
      category: live.category,
      capUnits: live.cap,
      allowedOnChain: live.allowed,
      identifiers: r ? (JSON.parse(r.identifiers_json) as string[]) : [],
      aliases: r ? (JSON.parse(r.aliases_json) as string[]) : [],
      bankDetails: r?.bank_details ?? null,
      terms: r?.terms_json ? (JSON.parse(r.terms_json) as AgreedTerms) : null,
    });
  }
  return out;
}
