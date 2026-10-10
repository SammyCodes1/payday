import "server-only";
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { spendPolicyAbi } from "./abi";
import { ownerOf, publicClient } from "./chain";
import { serverConfig } from "./config";
import { getTenantByOwner, upsertTenant } from "./db";
import { spendPolicyFactoryAbi } from "./factory-abi";
import { defaultPolicy } from "./tenant";

export interface ResolvedTenant {
  policy: Address;
  owner: Address;
  demo: boolean;
}

/**
 * Which policy does this wallet control? Its registered tenant policy if it is STILL the on-chain
 * owner, otherwise the configured demo policy if it owns that, otherwise none.
 * Chain is the source of truth; the tenants table is only a lookup index.
 */
export async function resolvePolicyFor(address: Address): Promise<ResolvedTenant | null> {
  const owner = getAddress(address);
  const t = getTenantByOwner(owner);
  if (t) {
    const policy = getAddress(t.policy_address);
    if ((await ownerOf(policy)) === owner) return { policy, owner, demo: policy === defaultPolicy() };
  }
  if ((await ownerOf(defaultPolicy())) === owner) return { policy: defaultPolicy(), owner, demo: true };
  return null;
}

export class TenantError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Record owner -> policy after the business created its policy through the factory.
 * Trustless: everything stored is read from chain (factory registry, the creation receipt, the
 * policy's owner/agent), so the caller cannot map a policy to someone who does not own it.
 */
export async function registerPolicy(policyIn: string, txHash: Hex) {
  const factory = serverConfig().PAYDAY_FACTORY_ADDRESS;
  if (!factory) throw new TenantError(503, "the SpendPolicy factory is not deployed yet");
  const policy = getAddress(policyIn);
  const pc = publicClient();
  const isPolicy = (await pc.readContract({ address: factory, abi: spendPolicyFactoryAbi, functionName: "isPolicy", args: [policy] })) as boolean;
  if (!isPolicy) throw new TenantError(400, "not a policy created by the Payday factory");

  const receipt = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") throw new TenantError(400, "creation transaction not found or failed");
  const created = receipt.logs.some((l) => {
    if (getAddress(l.address) !== factory) return false;
    try {
      const ev = decodeEventLog({ abi: spendPolicyFactoryAbi, data: l.data, topics: l.topics });
      return ev.eventName === "PolicyCreated" && getAddress((ev.args as { policy: Address }).policy) === policy;
    } catch {
      return false;
    }
  });
  if (!created) throw new TenantError(400, "transaction did not create this policy");

  const [owner, agent] = (await Promise.all([
    pc.readContract({ address: policy, abi: spendPolicyAbi, functionName: "owner" }),
    pc.readContract({ address: policy, abi: spendPolicyAbi, functionName: "agent" }),
  ])) as [Address, Address];
  upsertTenant({ owner: getAddress(owner), policy, agent: getAddress(agent), deployBlock: receipt.blockNumber, txHash });
  return { owner: getAddress(owner), policy, agent: getAddress(agent), deployBlock: receipt.blockNumber };
}
