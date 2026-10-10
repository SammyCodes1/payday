import "server-only";
import { getAddress } from "viem";
import { NextResponse } from "next/server";
import { serverConfig } from "../config";
import { resolvePolicyFor, TenantError } from "../tenants";
import { bindScope, NoTenantError, runInScope } from "../tenant";
import { clientIp, rateLimit, type Bucket } from "../rate-limit";
import { SESSION_COOKIE, verifySession } from "./session";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function cookieFrom(req: Request, name: string) {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite=Strict). */
export function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && origin !== serverConfig().PAYDAY_APP_ORIGIN) throw new HttpError(403, "cross-origin request refused");
}

export function limit(req: Request, bucket: Bucket) {
  const r = rateLimit(clientIp(req), bucket);
  if (!r.ok) throw new HttpError(429, "rate limit exceeded", { "Retry-After": String(r.retryAfter) });
}

/**
 * Authenticated owner: valid session AND still the on-chain owner of THEIR policy. Binds the
 * request to that policy, so every later read/write in this request only touches it.
 */
export async function requireOwner(req: Request, bucket: Bucket = "read") {
  limit(req, bucket);
  assertSameOrigin(req);
  const session = await verifySession(cookieFrom(req, SESSION_COOKIE), serverConfig().SESSION_SECRET);
  if (!session) throw new HttpError(401, "not signed in");
  const tenant = await resolvePolicyFor(getAddress(session.sub));
  if (!tenant) throw new HttpError(403, "session address is no longer the owner of a Payday policy");
  bindScope(tenant.policy, tenant.owner);
  return { address: tenant.owner, policy: tenant.policy };
}

/** Wraps a route handler: converts thrown errors to JSON without leaking internals. */
export function handle<A extends unknown[]>(fn: (req: Request, ...rest: A) => Promise<Response>) {
  return async (req: Request, ...rest: A): Promise<Response> => {
    try {
      return await runInScope(() => fn(req, ...rest));
    } catch (e) {
      if (e instanceof NoTenantError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof TenantError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status, headers: e.headers });
      console.error("[payday] route error:", e instanceof Error ? e.message : "unknown");
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
  };
}

/** JSON with bigint support. */
export function json(data: unknown, init?: ResponseInit) {
  return new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    ...init,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}
