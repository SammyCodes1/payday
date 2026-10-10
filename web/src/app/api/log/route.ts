import { handle, json, requireOwner } from "@/lib/auth/guard";
import { buildDecisionLog } from "@/lib/events";

export const dynamic = "force-dynamic";
export const GET = handle(async (req) => {
  await requireOwner(req);
  return json({ entries: await buildDecisionLog() });
});
