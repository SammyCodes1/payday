"use client";
/** Small fetch helper for same-origin JSON API calls (session cookie is HttpOnly). */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const fmtUsdc = (units: string | null | undefined) => {
  if (!units) return "-";
  const n = BigInt(units);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${frac} USDC`;
};
