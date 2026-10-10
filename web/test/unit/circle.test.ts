import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CircleExecutor, type CircleClientLike } from "@/lib/executor/circle";
import { categoryToBytes32 } from "@/lib/ids";
import { ADEBAYO, POLICY } from "./helpers";

const PID = ("0x" + "ab".repeat(32)) as Hex;
const RH = ("0x" + "cd".repeat(32)) as Hex;
const TX = ("0x" + "ef".repeat(32)) as Hex;

function fakeClient(states: string[]) {
  const calls: Parameters<CircleClientLike["createContractExecutionTransaction"]>[0][] = [];
  let i = 0;
  const client: CircleClientLike = {
    async createContractExecutionTransaction(input) {
      calls.push(input);
      return { data: { id: "11111111-1111-4111-8111-111111111111", state: "INITIATED" } };
    },
    async getTransaction() {
      const state = states[Math.min(i++, states.length - 1)]!;
      return { data: { transaction: { state, txHash: state === "COMPLETE" ? TX : undefined, errorReason: state === "FAILED" ? "EXECUTION_REVERTED" : undefined } } };
    },
  };
  return { client, calls };
}
const exec = (client: CircleClientLike) =>
  new CircleExecutor({ client, walletId: "22222222-2222-4222-8222-222222222222", walletAddress: ADEBAYO as Address, policy: POLICY, pollIntervalMs: 1, maxPolls: 5 });

describe("Circle developer-controlled wallet executor (fake client)", () => {
  it("submits requestPayment as a contract execution with string params and a deterministic UUID idempotency key", async () => {
    const { client, calls } = fakeClient(["INITIATED", "SENT", "COMPLETE"]);
    const r = await exec(client).requestPayment({ paymentId: PID, payee: ADEBAYO, amount: 1_450_000_000n, category: categoryToBytes32("REPAIRS"), reasonHash: RH, invoiceKey: RH });
    expect(r.txHash).toBe(TX);
    expect(calls[0]).toMatchObject({
      walletId: "22222222-2222-4222-8222-222222222222",
      contractAddress: POLICY,
      abiFunctionSignature: "requestPayment(bytes32,address,uint256,bytes32,bytes32,bytes32)",
      abiParameters: [PID, ADEBAYO, "1450000000", categoryToBytes32("REPAIRS"), RH, RH],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    expect(calls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const again = fakeClient(["COMPLETE"]);
    await exec(again.client).requestPayment({ paymentId: PID, payee: ADEBAYO, amount: 1n, category: RH, reasonHash: RH, invoiceKey: RH });
    expect(again.calls[0]!.idempotencyKey).toBe(calls[0]!.idempotencyKey); // retry-safe
  });
  it("relays an owner approval via approvePendingWithSig", async () => {
    const { client, calls } = fakeClient(["CONFIRMED", "COMPLETE"]);
    await exec(client).relayApproval({ paymentId: PID, nonce: 7n, deadline: 99n, signature: "0x1234" });
    expect(calls[0]).toMatchObject({ abiFunctionSignature: "approvePendingWithSig(bytes32,uint256,uint256,bytes)", abiParameters: [PID, "7", "99", "0x1234"] });
  });
  it("surfaces FAILED with the error reason", async () => {
    const { client } = fakeClient(["SENT", "FAILED"]);
    await expect(exec(client).requestPayment({ paymentId: PID, payee: ADEBAYO, amount: 1n, category: RH, reasonHash: RH, invoiceKey: RH })).rejects.toThrow(/FAILED: EXECUTION_REVERTED/);
  });
  it("gives up after max polls", async () => {
    const { client } = fakeClient(["SENT"]);
    await expect(exec(client).requestPayment({ paymentId: PID, payee: ADEBAYO, amount: 1n, category: RH, reasonHash: RH, invoiceKey: RH })).rejects.toThrow(/not final/);
  });
});
