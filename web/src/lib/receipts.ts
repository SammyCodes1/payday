import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from "viem";
import { spendPolicyAbi } from "./abi";

export type Outcome = "Executed" | "Pending" | "Approved" | "Unknown";

/** Find what the policy did with `paymentId` in this receipt. */
export function outcomeFromReceipt(receipt: TransactionReceipt, policy: Address, paymentId: Hex): Outcome {
  let out: Outcome = "Unknown";
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== policy.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: spendPolicyAbi, data: log.data, topics: log.topics });
      const id = (ev.args as { paymentId?: Hex }).paymentId;
      if (id?.toLowerCase() !== paymentId.toLowerCase()) continue;
      if (ev.eventName === "PaymentExecuted") return "Executed";
      if (ev.eventName === "PaymentPending") out = "Pending";
      if (ev.eventName === "PaymentApproved") out = "Approved";
    } catch {
      /* not a policy event */
    }
  }
  return out;
}
