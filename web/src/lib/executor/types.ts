import type { Address, Hex } from "viem";

export interface PaymentRequest {
  paymentId: Hex;
  payee: Address;
  amount: bigint;
  category: Hex;
  reasonHash: Hex;
  /** On-chain invoice dedup key (see ids.ts computeInvoiceKey); 0x00..00 = none. */
  invoiceKey: Hex;
}

export interface SignedApproval {
  paymentId: Hex;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

/**
 * The agent's ONLY capabilities: submit requestPayment, and relay an owner-signed approval.
 * Neither can move money outside the SpendPolicy rules.
 */
export interface AgentExecutor {
  readonly name: string;
  agentAddress(): Promise<Address>;
  requestPayment(req: PaymentRequest): Promise<{ txHash: Hex; ref: string | null }>;
  relayApproval(a: SignedApproval): Promise<{ txHash: Hex; ref: string | null }>;
}

export const REQUEST_PAYMENT_SIG = "requestPayment(bytes32,address,uint256,bytes32,bytes32,bytes32)";
export const APPROVE_WITH_SIG_SIG = "approvePendingWithSig(bytes32,uint256,uint256,bytes)";
