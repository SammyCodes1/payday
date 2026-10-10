import { timingSafeEqual } from "node:crypto";
import { handle, HttpError, json, limit, requireOwner } from "@/lib/auth/guard";
import { serverConfig } from "@/lib/config";
import { runDueSchedule } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/** Re-evaluate due SCHEDULED invoices. Auth: `Authorization: Bearer $CRON_SECRET` or owner session. */
export const POST = handle(async (req) => {
  limit(req, "write");
  const secret = serverConfig().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const given = Buffer.from(auth.replace(/^Bearer /, ""));
  const ok = !!secret && given.length === secret.length && timingSafeEqual(given, Buffer.from(secret));
  if (!ok) {
    if (auth) throw new HttpError(401, "bad cron secret");
    await requireOwner(req, "write"); // owner session: only their own policy
    return json({ processed: await runDueSchedule() });
  }
  return json({ processed: await runDueSchedule({ allTenants: true }) });
});
