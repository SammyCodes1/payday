import type { Hex } from "viem";
import { spendPolicyAbi } from "@/lib/abi";
import { handle, json, requireOwner } from "@/lib/auth/guard";
import { publicClient } from "@/lib/chain";
import { getDb } from "@/lib/db";
import { currentPolicyEvents, pendingFromEvents } from "@/lib/events";
import { syncOnchainStatuses } from "@/lib/pipeline";
import { activePolicy } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Pending approvals, rebuilt from chain (PaymentPending without a closing event). */
export const GET = handle(async (req) => {
  await requireOwner(req);
  await syncOnchainStatuses();
  const pending = pendingFromEvents(await currentPolicyEvents());
  const chainId = await publicClient().getChainId();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const readP = <T,>(functionName: string, args: readonly unknown[] = []) =>
    publicClient().readContract({ address: activePolicy(), abi: spendPolicyAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [ownerEpoch, agentEpoch, openPending, maxOpenPending] = await Promise.all([
    readP<number>("ownerEpoch"),
    readP<number>("agentEpoch"),
    readP<bigint>("openPending"),
    readP<bigint>("maxOpenPending"),
  ]);
  const items = [];
  for (const e of pending) {
    const id = e.args.paymentId as Hex;
    const p = (await publicClient().readContract({ address: activePolicy(), abi: spendPolicyAbi, functionName: "getPayment", args: [id] })) as {
      payee: Hex;
      status: number;
      expiresAt: bigint;
      amount: bigint;
      category: Hex;
      reasonHash: Hex;
      invoiceKey: Hex;
      agentEpoch: number;
      payeeEpoch: number;
    };
    if (Number(p.status) !== 1) continue;
    // The contract refuses approval of these (audit L-02 / L-03); the owner can only reject them.
    const payee = await readP<{ allowed: boolean; category: Hex }>("getPayee", [p.payee]);
    const curPayeeEpoch = await readP<number>("payeeEpoch", [p.payee]);
    const blockedReason =
      Number(p.agentEpoch) !== Number(agentEpoch)
        ? "Requested by a previous agent key (rotated since). Approval is refused on chain; reject it."
        : !payee.allowed
          ? "Payee is no longer on the allow-list. Approval is refused on chain; reject it."
          : Number(p.payeeEpoch) !== Number(curPayeeEpoch)
            ? "Payee was removed and re-added since this request. Approval is refused on chain; reject it."
            : payee.category.toLowerCase() !== p.category.toLowerCase()
              ? "Payee's category changed since this request. Approval is refused on chain."
              : null;
    const inv = getDb().prepare("SELECT id, file_name, explanation, extraction_json FROM invoices WHERE payment_id = ? AND policy_address = ? ORDER BY created_at DESC LIMIT 1").get(id, activePolicy()) as
      | { id: string; file_name: string; explanation: string | null; extraction_json: string | null }
      | undefined;
    items.push({
      paymentId: id,
      payee: p.payee,
      amount: p.amount.toString(),
      category: p.category,
      reasonHash: p.reasonHash,
      overLimits: Number(e.args.overLimits ?? 0),
      expiresAt: p.expiresAt.toString(),
      invoiceKey: p.invoiceKey,
      blockedReason,
      expired: p.expiresAt < nowSec,
      txHash: e.txHash,
      invoiceId: inv?.id ?? null,
      fileName: inv?.file_name ?? null,
      title: (() => {
        const x = inv?.extraction_json ? (JSON.parse(inv.extraction_json) as { payeeName?: string; invoiceNumber?: string }) : null;
        return x ? `${x.payeeName ?? ""} · ${x.invoiceNumber ?? ""}` : null;
      })(),
      explanation: inv?.explanation ?? null,
    });
  }
  return json({
    policy: activePolicy(),
    chainId,
    eip712: { name: "Payday SpendPolicy", version: "1", chainId, verifyingContract: activePolicy() },
    ownerEpoch: String(ownerEpoch),
    openPending: openPending.toString(),
    maxOpenPending: maxOpenPending.toString(),
    items,
  });
});
