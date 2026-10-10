/**
 * In-memory fixed-window rate limiter keyed by client IP + bucket. Fine for one server
 * process (hackathon / single instance). For multiple instances, back this with Redis.
 */
const windows = new Map<string, { start: number; count: number }>();

export const LIMITS = {
  auth: { max: 20, windowMs: 60_000 },
  upload: { max: 10, windowMs: 60_000 },
  write: { max: 60, windowMs: 60_000 },
  read: { max: 240, windowMs: 60_000 },
  public: { max: 60, windowMs: 60_000 },
} as const;
export type Bucket = keyof typeof LIMITS;

export function rateLimit(key: string, bucket: Bucket, now = Date.now()): { ok: boolean; retryAfter: number } {
  const { max, windowMs } = LIMITS[bucket];
  const k = `${bucket}:${key}`;
  const w = windows.get(k);
  if (!w || now - w.start >= windowMs) {
    windows.set(k, { start: now, count: 1 });
    if (windows.size > 50_000) windows.clear(); // crude memory bound
    return { ok: true, retryAfter: 0 };
  }
  w.count++;
  if (w.count > max) return { ok: false, retryAfter: Math.ceil((w.start + windowMs - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

export function resetRateLimitsForTests() {
  windows.clear();
}

/** Client IP. Only the first X-Forwarded-For hop is used; deploy behind a proxy that sets it. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local").slice(0, 64);
}
