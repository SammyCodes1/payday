import { getAddress, isAddress } from "viem";
import { handle, HttpError, json, requireOwner } from "@/lib/auth/guard";
import { bytes32ToCategory } from "@/lib/ids";
import { loadRegistry, PayeeRecordInput, savePayeeRecord } from "@/lib/registry";
import { readPayee } from "@/lib/chain";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  await requireOwner(req);
  const reg = await loadRegistry();
  return json({
    payees: reg.map((e) => ({ ...e, categoryLabel: bytes32ToCategory(e.category), capUnits: e.capUnits.toString() })),
  });
});

/** Save app-side terms for a payee that is ALREADY allow-listed on chain (owner wallet tx). */
export const POST = handle(async (req) => {
  const owner = await requireOwner(req, "write");
  const body = PayeeRecordInput.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new HttpError(400, body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (!isAddress(body.data.address)) throw new HttpError(400, "invalid address");
  const onchain = await readPayee(getAddress(body.data.address));
  if (!onchain.allowed) throw new HttpError(409, "add this payee on chain (setPayee) first");
  savePayeeRecord(body.data, owner.address);
  return json({ ok: true });
});
