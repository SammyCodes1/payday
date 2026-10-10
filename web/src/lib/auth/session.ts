/**
 * Stateless session token: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Uses Web Crypto so it works in both route handlers and proxy. Secret = SESSION_SECRET.
 */
export interface SessionPayload {
  sub: string; // owner address (checksummed)
  role: "owner";
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = "payday_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifySession(token: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || token.length > 2048) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(expected, new Uint8Array(Buffer.from(sig, "base64url")))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (p.role !== "owner" || typeof p.sub !== "string" || p.exp <= nowSec) return null;
    return p;
  } catch {
    return null;
  }
}
