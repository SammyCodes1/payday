import { handle, json, limit } from "@/lib/auth/guard";
import { issueNonce } from "@/lib/auth/siwe";
import { publicClient } from "@/lib/chain";
import { serverConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  limit(req, "auth");
  const origin = new URL(serverConfig().PAYDAY_APP_ORIGIN);
  return json({ nonce: issueNonce(), domain: origin.host, uri: origin.origin, chainId: await publicClient().getChainId() });
});
