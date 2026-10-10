import "server-only";
import { createPublicClient, erc20Abi, http, type Address, type Hex, type PublicClient } from "viem";
import { spendPolicyAbi } from "./abi";
import { chainFor } from "./chains";
import { serverConfig } from "./config";
import { activePolicy } from "./tenant";
import type { ChainState } from "./decision/types";

export function publicClient(): PublicClient {
  const cfg = serverConfig();
  const chain = chainFor(cfg.PAYDAY_CHAIN);
  return createPublicClient({ chain, transport: http(cfg.PAYDAY_RPC_URL ?? chain.rpcUrls.default.http[0]) }) as PublicClient;
}

/** The policy of the current tenant (see tenant.ts); the demo policy outside a tenant scope. */
export function policyAddress(): Address {
  return activePolicy();
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

const ownerCache = new Map<Address, { at: number; owner: Address }>();
/** On-chain owner of `policy` (cached 15 s) - sessions are re-checked against it. */
export async function ownerOf(policy: Address): Promise<Address> {
  const hit = ownerCache.get(policy);
  if (hit && Date.now() - hit.at < 15_000) return hit.owner;
  const owner = (await publicClient().readContract({ address: policy, abi: spendPolicyAbi, functionName: "owner" })) as Address;
  ownerCache.set(policy, { at: Date.now(), owner });
  return owner;
}

/** Current on-chain owner of the active policy. */
export async function currentOwner(): Promise<Address> {
  return ownerOf(activePolicy());
}

export function clearOwnerCacheForTests() {
  ownerCache.clear();
}
