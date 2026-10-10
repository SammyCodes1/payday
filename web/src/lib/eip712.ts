import type { Address, Hex } from "viem";

/**
 * EIP-712 approval typed data for SpendPolicy.approvePendingWithSig. Must match
 * `SpendPolicy.APPROVE_TYPEHASH` exactly (field names, types and order). Binds every immutable
 * field of the pending payment (audit I-05) and the owner tenure `ownerEpoch` (audit L-04).
 */
export const APPROVE_TYPES = {
  ApprovePending: [
    { name: "paymentId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "category", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "ownerEpoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const APPROVE_TYPE_STRING =
  "ApprovePending(bytes32 paymentId,address payee,uint256 amount,bytes32 category,bytes32 reasonHash,uint64 expiresAt,uint256 ownerEpoch,uint256 nonce,uint256 deadline)";

export function approvalDomain(chainId: number, policy: Address) {
  return { name: "Payday SpendPolicy", version: "1", chainId, verifyingContract: policy } as const;
}

export interface PendingFields {
  paymentId: Hex;
  payee: Address;
  amount: bigint;
  category: Hex;
  reasonHash: Hex;
  expiresAt: bigint;
}

export function approvalMessage(p: PendingFields, ownerEpoch: bigint, nonce: bigint, deadline: bigint) {
  return {
    paymentId: p.paymentId,
    payee: p.payee,
    amount: p.amount,
    category: p.category,
    reasonHash: p.reasonHash,
    expiresAt: p.expiresAt,
    ownerEpoch,
    nonce,
    deadline,
  };
}
