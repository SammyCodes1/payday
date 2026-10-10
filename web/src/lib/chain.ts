import "server-only";
import { createPublicClient, erc20Abi, http, type Address, type Hex, type PublicClient } from "viem";
import { spendPolicyAbi } from "./abi";
import { chainFor } from "./chains";
import { serverConfig } from "./config";
import type { ChainState } from "./decision/types";

export function publicClient(): PublicClient {
  const cfg = serverConfig();
  const chain = chainFor(cfg.PAYDAY_CHAIN);
  return createPublicClient({ chain, transport: http(cfg.PAYDAY_RPC_URL ?? chain.rpcUrls.default.http[0]) }) as PublicClient;
}

export function policyAddress(): Address {
  return serverConfig().PAYDAY_POLICY_ADDRESS;
}

const read = <T>(fn: string, args: readonly unknown[] = []) =>
  publicClient().readContract({ address: policyAddress(), abi: spendPolicyAbi, functionName: fn as never, args: args as never }) as Promise<T>;

export async function readPolicyOverview() {
  const [owner, agent, token, paused, perPaymentCap, monthlyCap, globalCeiling, totalPaid, pendingTtl, spentInWindow] =
    await Promise.all([
      read<Address>("owner"),
      read<Address>("agent"),
      read<Address>("token"),
      read<boolean>("paused"),
      read<bigint>("perPaymentCap"),
      read<bigint>("monthlyCap"),
      read<bigint>("globalCeiling"),
      read<bigint>("totalPaid"),
      read<bigint>("pendingTtl"),
      read<bigint>("spentInWindow"),
    ]);
  const balance = await publicClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [policyAddress()] });
  const chainId = await publicClient().getChainId();
  return { chainId, policy: policyAddress(), owner, agent, token, paused, perPaymentCap, monthlyCap, globalCeiling, totalPaid, pendingTtl, spentInWindow, balance };
}

export async function readChainState(args: { payee: Address; category: Hex; paymentId: Hex }): Promise<ChainState> {
  const o = await readPolicyOverview();
  const [categoryBudget, categorySpent, payeeSpent, payment] = await Promise.all([
    read<bigint>("categoryBudget", [args.category]),
    read<bigint>("categorySpentInWindow", [args.category]),
    read<bigint>("payeeSpentInWindow", [args.payee]),
    read<{ status: number }>("getPayment", [args.paymentId]),
  ]);
  return {
    chainId: o.chainId,
    policy: o.policy,
    paused: o.paused,
    perPaymentCap: o.perPaymentCap,
    monthlyCap: o.monthlyCap,
    spentInWindow: o.spentInWindow,
    categoryBudget,
    categorySpent,
    payeeSpent,
    globalCeiling: o.globalCeiling,
    totalPaid: o.totalPaid,
    balance: o.balance,
    paymentStatus: Number(payment.status),
  };
}

export async function readPayee(payee: Address) {
  return read<{ allowed: boolean; category: Hex; cap: bigint; label: string }>("getPayee", [payee]);
}

let ownerCache: { at: number; owner: Address } | null = null;
/** Current on-chain owner (cached 15 s) - sessions are re-checked against it. */
export async function currentOwner(): Promise<Address> {
  if (ownerCache && Date.now() - ownerCache.at < 15_000) return ownerCache.owner;
  const owner = await read<Address>("owner");
  ownerCache = { at: Date.now(), owner };
  return owner;
}

export function clearOwnerCacheForTests() {
  ownerCache = null;
}
