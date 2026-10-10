/** Upload limits: size cap, allowed types, and magic-byte check so the declared type can't lie. */
export const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export class UploadError extends Error {
  constructor(
    public status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export function sniffType(b: Uint8Array): AllowedType | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (s(0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  return null;
}

export function validateUpload(bytes: Uint8Array, declaredType: string, maxBytes: number): AllowedType {
  if (bytes.byteLength === 0) throw new UploadError(400, "empty file");
  if (bytes.byteLength > maxBytes) throw new UploadError(413, `file larger than ${maxBytes} bytes`);
  if (!(ALLOWED_TYPES as readonly string[]).includes(declaredType)) throw new UploadError(415, "unsupported file type");
  const sniffed = sniffType(bytes);
  if (sniffed !== declaredType) throw new UploadError(415, "file content does not match its declared type");
  return sniffed;
}
