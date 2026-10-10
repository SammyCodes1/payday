import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * Next 16 proxy (formerly middleware): first gate for every /api route. Routes ALSO call
 * requireOwner(), which additionally re-checks the on-chain owner.
 */
const PUBLIC_API = ["/api/auth/nonce", "/api/auth/verify", "/api/auth/logout", "/api/stats", "/api/cron/due"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_API.includes(pathname)) return NextResponse.next();
  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret) : null;
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
