/**
 * Canonical JSON (RFC 8785 / JCS subset) used for reasonHash.
 * - object keys sorted by UTF-16 code units (JS default sort), no whitespace
 * - strings escaped by JSON.stringify
 * - numbers: safe integers only (amounts are decimal STRINGS), no floats, no NaN
 * - booleans, null, arrays allowed; `undefined` is rejected (be explicit with null)
 */
export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [k: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error("canonical JSON: only safe integers allowed");
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => {
          if (obj[k] === undefined) throw new Error(`canonical JSON: undefined at key ${k}`);
          return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
        })
        .join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON: unsupported type ${typeof value}`);
  }
}
