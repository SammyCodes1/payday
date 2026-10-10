import { handle, json, requireOwner } from "@/lib/auth/guard";
import { readPolicyOverview } from "@/lib/chain";

export const dynamic = "force-dynamic";
export const GET = handle(async (req) => {
  await requireOwner(req);
  return json(await readPolicyOverview());
});
