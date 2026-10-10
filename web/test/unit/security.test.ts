import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "@/lib/auth/session";
import { sniffType, UploadError, validateUpload } from "@/lib/invoice/upload";
import { clientIp, LIMITS, rateLimit, resetRateLimitsForTests } from "@/lib/rate-limit";
import { fixture } from "./helpers";

describe("upload limits", () => {
  const pdf = fixture("01-normal.pdf");
  it("accepts a real PDF / PNG", () => {
    expect(validateUpload(pdf, "application/pdf", 5_000_000)).toBe("application/pdf");
    expect(validateUpload(fixture("10-photo.png"), "image/png", 5_000_000)).toBe("image/png");
  });
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof UploadError ? e.status : -1;
    }
    return 0;
  };
  it("413 when over the size cap", () => expect(status(() => validateUpload(pdf, "application/pdf", 100))).toBe(413));
  it("415 for a disallowed type", () => expect(status(() => validateUpload(pdf, "text/html", 5_000_000))).toBe(415));
  it("415 when the content does not match the declared type", () => {
    expect(status(() => validateUpload(pdf, "image/png", 5_000_000))).toBe(415);
    expect(status(() => validateUpload(new TextEncoder().encode("<script>"), "application/pdf", 5_000_000))).toBe(415);
  });
  it("400 for an empty file", () => expect(status(() => validateUpload(new Uint8Array(), "application/pdf", 10))).toBe(400));
  it("sniffs JPEG and WebP magic bytes", () => {
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });
});

describe("rate limit", () => {
  it("blocks after the bucket max within the window, then resets", () => {
    resetRateLimitsForTests();
    const t = 1_000_000;
    for (let i = 0; i < LIMITS.upload.max; i++) expect(rateLimit("1.2.3.4", "upload", t).ok).toBe(true);
    const blocked = rateLimit("1.2.3.4", "upload", t + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(rateLimit("5.6.7.8", "upload", t).ok).toBe(true); // other client unaffected
    expect(rateLimit("1.2.3.4", "upload", t + LIMITS.upload.windowMs).ok).toBe(true);
  });
  it("uses the first X-Forwarded-For hop", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }))).toBe("9.9.9.9");
  });
});

describe("session token", () => {
  const secret = "unit-test-secret-not-real-0123456789abcdef";
  const now = 1_800_000_000;
  const payload = { sub: "0x0000000000000000000000000000000000000001", role: "owner" as const, iat: now, exp: now + 60 };
  it("round-trips", async () => {
    expect(await verifySession(await signSession(payload, secret), secret, now)).toMatchObject({ sub: payload.sub });
  });
  it("rejects tampering, wrong secret and expiry", async () => {
    const t = await signSession(payload, secret);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: "0x0000000000000000000000000000000000000bad" })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, secret, now)).toBeNull();
    expect(await verifySession(`${body}.${sig}x`, secret, now)).toBeNull();
    expect(await verifySession(t, secret + "x", now)).toBeNull();
    expect(await verifySession(t, secret, now + 61)).toBeNull();
    expect(await verifySession(undefined, secret, now)).toBeNull();
    expect(await verifySession("garbage", secret, now)).toBeNull();
  });
});
