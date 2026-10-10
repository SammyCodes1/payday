import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { assertSameOrigin, handle, HttpError, json, limit } from "@/lib/auth/guard";
import { publicClient } from "@/lib/chain";
import { ARC_USDC } from "@/lib/chains";
import { serverConfig } from "@/lib/config";
import { getTenantByOwner } from "@/lib/db";
import { getExecutor } from "@/lib/executor";
import { registerPolicy } from "@/lib/tenants";

export const dynamic = "force-dynamic";

/** Payday's own agent wallet (public address), offered as the default agent for new policies. */
async function hostedAgent() {
  const cfg = serverConfig();
  if (cfg.PAYDAY_EXECUTOR === "circle") return cfg.CIRCLE_AGENT_WALLET_ADDRESS ?? null;
  if (cfg.PAYDAY_EXECUTOR === "local") return (await getExecutor())?.agentAddress() ?? null;
  return null;
}

/**
 * PUBLIC onboarding config. Everything here is already public on chain.
 * `?owner=0x…` also returns that wallet's registered policy (if any).
 */
export const GET = handle(async (req) => {
  limit(req, "public");
  const cfg = serverConfig();
  const ownerParam = new URL(req.url).searchParams.get("owner");
  let existing: { policy: string; agent: string } | null = null;
  if (ownerParam) {
    if (!isAddress(ownerParam)) throw new HttpError(400, "invalid owner address");
    const t = getTenantByOwner(getAddress(ownerParam));
    existing = t ? { policy: t.policy_address, agent: t.agent_address } : null;
  }
  return json({
    chainId: await publicClient().getChainId(),
    factory: cfg.PAYDAY_FACTORY_ADDRESS ?? null,
    token: ARC_USDC,
    hostedAgent: await hostedAgent(),
    defaults: { perPaymentUsdc: "20", monthlyUsdc: "100", ceilingUsdc: "200", ttlDays: 7 },
    existing,
  });
});

const Body = z
  .object({
    policy: z.string().refine((v) => isAddress(v), "invalid policy address"),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();

/**
 * Register the policy a business just created through the factory (owner -> policy mapping).
 * No session needed: every stored value is verified on chain (factory registry + creation receipt
 * + the policy's own owner()), so nobody can attach a policy to a wallet that does not own it.
 */
export const POST = handle(async (req) => {
  limit(req, "auth");
  assertSameOrigin(req);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new HttpError(400, "invalid body");
  const t = await registerPolicy(body.data.policy, body.data.txHash as `0x${string}`);
  return json(t);
});
