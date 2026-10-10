import { handle, json, limit } from "@/lib/auth/guard";
import { publicStats } from "@/lib/events";

export const dynamic = "force-dynamic";
/** PUBLIC. Counts only on-chain PaymentExecuted events. */
export const GET = handle(async (req) => {
  limit(req, "public");
  return json(await publicStats());
});
