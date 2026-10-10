import { z } from "zod";
import type { Address, Hex } from "viem";
import { spendPolicyAbi } from "@/lib/abi";
import { APPROVE_TYPES, approvalDomain, approvalMessage } from "@/lib/eip712";
import { handle, HttpError, json, requireOwner } from "@/lib/auth/guard";
import { publicClient } from "@/lib/chain";
import { getExecutor } from "@/lib/executor";
import { outcomeFromReceipt } from "@/lib/receipts";
import { syncOnchainStatuses } from "@/lib/pipeline";
import { activePolicy } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    nonce: z.string().regex(/^\d{1,78}$/),
    deadline: z.string().regex(/^\d{1,20}$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/).max(1000),
  })
  .strict();

/**
 * The OWNER signed an EIP-712 ApprovePending in the browser; the agent wallet relays it via
 * approvePendingWithSig (so the Circle Gas Station can sponsor gas). The agent cannot forge
 * this: the contract recovers the signer and requires the current owner.
 */
export const POST = handle(async (req) => {
  const owner = await requireOwner(req, "write");
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new HttpError(400, "invalid body");
  const paymentId = body.data.paymentId as Hex;
  const nonce = BigInt(body.data.nonce);
  const deadline = BigInt(body.data.deadline);
  const signature = body.data.signature as Hex;
  const client = publicClient();
  const p = (await client.readContract({ address: activePolicy(), abi: spendPolicyAbi, functionName: "getPayment", args: [paymentId] })) as {
    payee: Address;
    amount: bigint;
    status: number;
    category: Hex;
    reasonHash: Hex;
    expiresAt: bigint;
  };
  if (Number(p.status) !== 1) throw new HttpError(409, "payment is not pending");
  const chainId = await client.getChainId();
  const ownerEpoch = BigInt(
    (await client.readContract({ address: activePolicy(), abi: spendPolicyAbi, functionName: "ownerEpoch" })) as number,
  );
  // EOA owners are checked here; a smart-contract owner (ERC-1271, audit I-01) is checked by the
  // contract itself in the simulation below.
  const code = await client.getCode({ address: owner.address });
  const valid =
    (code !== undefined && code !== "0x") ||
    (await client.verifyTypedData({
      address: owner.address,
      domain: approvalDomain(chainId, activePolicy()),
      types: APPROVE_TYPES,
      primaryType: "ApprovePending",
      message: approvalMessage({ paymentId, payee: p.payee, amount: p.amount, category: p.category, reasonHash: p.reasonHash, expiresAt: BigInt(p.expiresAt) }, ownerEpoch, nonce, deadline),
      signature,
    }));
  if (!valid) throw new HttpError(400, "signature is not the owner's approval for this payment");

  const executor = await getExecutor();
  if (!executor) throw new HttpError(503, "no executor configured");
  const agent = await executor.agentAddress();
  await client.simulateContract({
    account: agent,
    address: activePolicy(),
    abi: spendPolicyAbi,
    functionName: "approvePendingWithSig",
    args: [paymentId, nonce, deadline, signature],
  });
  const { txHash } = await executor.relayApproval({ paymentId, nonce, deadline, signature });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  const outcome = outcomeFromReceipt(receipt, activePolicy(), paymentId);
  await syncOnchainStatuses();
  return json({ txHash, outcome: receipt.status === "success" ? outcome : "Reverted" });
});
