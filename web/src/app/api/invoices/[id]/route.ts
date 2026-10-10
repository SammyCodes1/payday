import { handle, HttpError, json, requireOwner } from "@/lib/auth/guard";
import { keccak256, toBytes } from "viem";
import { getDb, getInvoice } from "@/lib/db";
import { serializeInvoice } from "../serialize";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await requireOwner(req);
  const row = getInvoice((await ctx.params).id);
  if (!row) throw new HttpError(404, "not found");
  // The app-side reason document for the latest decision, verified against its hash.
  const doc = row.reason_hash
    ? (getDb().prepare("SELECT canonical_json FROM reason_docs WHERE reason_hash = ?").get(row.reason_hash.toLowerCase()) as { canonical_json: string } | undefined)
    : undefined;
  const reasonDoc = doc && keccak256(toBytes(doc.canonical_json)).toLowerCase() === row.reason_hash!.toLowerCase() ? JSON.parse(doc.canonical_json) : null;
  return json({ invoice: serializeInvoice(row), reasonDoc });
});
