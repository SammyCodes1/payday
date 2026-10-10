import "server-only";
import type { Address, Hex } from "viem";
import { idempotencyKeyFor } from "../ids";
import {
  APPROVE_WITH_SIG_SIG,
  REQUEST_PAYMENT_SIG,
  type AgentExecutor,
  type PaymentRequest,
  type SignedApproval,
} from "./types";

/**
 * Circle Developer-Controlled Wallets executor.
 *
 * - The agent is a Circle dev-controlled wallet on ARC-TESTNET. Use accountType "SCA" so Circle
 *   Gas Station (paymaster) sponsors gas; Arc Testnet has a preconfigured sponsorship policy.
 *   https://developers.circle.com/wallets/gas-station
 * - Calls POST /v1/w3s/developer/transactions/contractExecution through the official SDK
 *   (createContractExecutionTransaction), then polls getTransaction until COMPLETE/CONFIRMED/FAILED.
 *   https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution
 * - The SDK re-encrypts the entity secret per request (ciphertexts are single-use).
 *   https://developers.circle.com/wallets/dev-controlled/entity-secret-management
 * - idempotencyKey is derived from the paymentId, so a retry can never create a 2nd transaction.
 */
export interface CircleClientLike {
  createContractExecutionTransaction(input: {
    idempotencyKey: string;
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: (string | number | boolean)[];
    refId?: string;
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
  }): Promise<{ data?: { id?: string; state?: string } }>;
  getTransaction(input: { id: string }): Promise<{
    data?: { transaction?: { state?: string; txHash?: string; errorReason?: string } };
  }>;
}

export interface CircleExecutorOptions {
  client: CircleClientLike;
  walletId: string;
  walletAddress: Address;
  policy: Address;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export class CircleExecutor implements AgentExecutor {
  readonly name = "circle";
  constructor(private o: CircleExecutorOptions) {}

  async agentAddress() {
    return this.o.walletAddress;
  }

  private async submit(signature: string, params: (string | number | boolean)[], key: string) {
    const res = await this.o.client.createContractExecutionTransaction({
      idempotencyKey: key,
      walletId: this.o.walletId,
      contractAddress: this.o.policy,
      abiFunctionSignature: signature,
      abiParameters: params,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = res.data?.id;
    if (!id) throw new Error("Circle did not return a transaction id");
    return { txHash: await this.waitForHash(id), ref: id };
  }

  async requestPayment(r: PaymentRequest) {
    return this.submit(
      REQUEST_PAYMENT_SIG,
      [r.paymentId, r.payee, r.amount.toString(), r.category, r.reasonHash, r.invoiceKey],
      idempotencyKeyFor("requestPayment", r.paymentId),
    );
  }

  async relayApproval(a: SignedApproval) {
    return this.submit(
      APPROVE_WITH_SIG_SIG,
      [a.paymentId, a.nonce.toString(), a.deadline.toString(), a.signature],
      idempotencyKeyFor("approvePendingWithSig", a.paymentId, a.nonce.toString()),
    );
  }

  private async waitForHash(id: string): Promise<Hex> {
    const max = this.o.maxPolls ?? 45;
    for (let i = 0; i < max; i++) {
      const tx = (await this.o.client.getTransaction({ id })).data?.transaction;
      if ((tx?.state === "COMPLETE" || tx?.state === "CONFIRMED") && tx.txHash) return tx.txHash as Hex;
      if (tx?.state === "FAILED" || tx?.state === "DENIED" || tx?.state === "CANCELLED") {
        throw new Error(`Circle transaction ${id} ${tx.state}: ${tx.errorReason ?? "no reason"}`);
      }
      await new Promise((r) => setTimeout(r, this.o.pollIntervalMs ?? 2000));
    }
    throw new Error(`Circle transaction ${id} not final after polling`);
  }
}

/** Builds the real SDK client. Credentials are read here, on the server, and nowhere else. */
export async function createCircleClient(apiKey: string, entitySecret: string): Promise<CircleClientLike> {
  const sdk = await import("@circle-fin/developer-controlled-wallets");
  return sdk.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret }) as unknown as CircleClientLike;
}
