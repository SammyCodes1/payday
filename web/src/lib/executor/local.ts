import "server-only";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { spendPolicyAbi } from "../abi";
import { anvil } from "../chains";
import type { AgentExecutor, PaymentRequest, SignedApproval } from "./types";

/**
 * LOCAL DEV ONLY: signs as the agent with an account from Foundry/Anvil's PUBLIC test mnemonic.
 * Refuses to run on any chain other than 31337, so it can never touch Arc.
 */
export const PUBLIC_TEST_MNEMONIC = "test test test test test test test test test test test junk";

export class LocalAnvilExecutor implements AgentExecutor {
  readonly name = "local-anvil";
  private account;
  constructor(
    private rpcUrl: string,
    private policy: Address,
    index: number,
  ) {
    this.account = mnemonicToAccount(PUBLIC_TEST_MNEMONIC, { addressIndex: index });
  }

  private async client() {
    const c = createWalletClient({ account: this.account, chain: anvil, transport: http(this.rpcUrl) });
    const id = await c.getChainId();
    if (id !== 31337) throw new Error(`local executor refuses chain ${id}`);
    return c;
  }

  async agentAddress() {
    return this.account.address;
  }

  async requestPayment(r: PaymentRequest): Promise<{ txHash: Hex; ref: string | null }> {
    const c = await this.client();
    const txHash = await c.writeContract({
      address: this.policy,
      abi: spendPolicyAbi,
      functionName: "requestPayment",
      args: [r.paymentId, r.payee, r.amount, r.category, r.reasonHash, r.invoiceKey],
    });
    return { txHash, ref: null };
  }

  async relayApproval(a: SignedApproval): Promise<{ txHash: Hex; ref: string | null }> {
    const c = await this.client();
    const txHash = await c.writeContract({
      address: this.policy,
      abi: spendPolicyAbi,
      functionName: "approvePendingWithSig",
      args: [a.paymentId, a.nonce, a.deadline, a.signature],
    });
    return { txHash, ref: null };
  }
}
