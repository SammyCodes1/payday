import { z } from "zod";
import { assertSameOrigin, handle, HttpError, json, limit } from "@/lib/auth/guard";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/auth/session";
import { verifySiwe } from "@/lib/auth/siwe";
import { serverConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
const Body = z.object({ message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4000) }).strict();

export const POST = handle(async (req) => {
  limit(req, "auth");
  assertSameOrigin(req);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new HttpError(400, "invalid body");
  const address = await verifySiwe(body.data.message, body.data.signature as `0x${string}`);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSession({ sub: address, role: "owner", iat, exp: iat + SESSION_TTL_SECONDS }, serverConfig().SESSION_SECRET);
  const secure = serverConfig().PAYDAY_APP_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return json(
    { address },
    { headers: { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}` } },
  );
});
