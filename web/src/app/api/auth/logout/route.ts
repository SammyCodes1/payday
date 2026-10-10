import { assertSameOrigin, handle, json } from "@/lib/auth/guard";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  return json({ ok: true }, { headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } });
});
