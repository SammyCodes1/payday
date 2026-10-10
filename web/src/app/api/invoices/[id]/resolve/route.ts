import { z } from "zod";
import { handle, HttpError, json, requireOwner } from "@/lib/auth/guard";
import { getDb, getInvoice, updateInvoice } from "@/lib/db";
import { ACKNOWLEDGEABLE_CODES, type Reason, type ReasonCode } from "@/lib/decision/types";
import { evaluateInvoice } from "@/lib/pipeline";
import { serializeInvoice } from "../../serialize";

export const dynamic = "force-dynamic";
const Body = z.object({ action: z.enum(["confirm", "reevaluate", "dismiss"]) }).strict();

/**
 * Owner actions on an app-held invoice:
 *  - confirm:    only for ASK held in-app; acknowledges the app-level ASK reasons and re-runs the
 *                engine (contract caps still apply - over-cap goes Pending on chain).
 *  - reevaluate: re-run the engine after fixing payee records/terms (ESCALATE, FAILED, SCHEDULED).
 *  - dismiss:    close the invoice without paying.
 */
export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const owner = await requireOwner(req, "write");
  const id = (await ctx.params).id;
  const row = getInvoice(id);
  if (!row) throw new HttpError(404, "not found");
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new HttpError(400, "invalid body");
  const terminal = ["EXECUTED", "ONCHAIN_PENDING", "SUBMITTING", "DISMISSED"];
  if (terminal.includes(row.status)) throw new HttpError(409, `invoice is ${row.status}`);

  if (body.data.action === "dismiss") {
    updateInvoice(id, { status: "DISMISSED" });
  } else if (body.data.action === "reevaluate") {
    await evaluateInvoice(id);
  } else {
    if (row.status !== "AWAITING_OWNER" || !row.reason_hash) throw new HttpError(409, "only invoices awaiting owner confirmation can be confirmed");
    const doc = getDb().prepare("SELECT canonical_json FROM reason_docs WHERE reason_hash = ?").get(row.reason_hash) as
      | { canonical_json: string }
      | undefined;
    const reasons = doc ? ((JSON.parse(doc.canonical_json) as { reasons: Reason[] }).reasons ?? []) : [];
    const codes = reasons.filter((r) => r.outcome === "ASK").map((r) => r.code);
    const blocking = codes.filter((c) => !ACKNOWLEDGEABLE_CODES.includes(c));
    if (blocking.length) throw new HttpError(409, `cannot confirm in-app: ${blocking.join(", ")}`);
    await evaluateInvoice(id, { ownerAcknowledged: codes as ReasonCode[], confirmedBy: owner.address });
  }
  return json({ invoice: serializeInvoice(getInvoice(id)!) });
});
