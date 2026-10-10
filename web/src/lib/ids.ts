import { encodeAbiParameters, keccak256, stringToHex, toBytes, type Address, type Hex } from "viem";
import { canonicalJson } from "./canonical-json";

/**
 * paymentId encoding (v1) - FIXED, do not change without bumping the tag:
 *
 *   paymentId = keccak256(abi.encode(
 *     bytes32 tag            = keccak256("PAYDAY_PAYMENT_ID_V1"),
 *     uint256 chainId,
 *     address policy,
 *     address payee,          // from the on-chain allow-list, never from invoice text
 *     uint256 amount,         // USDC units, 6 decimals
 *     bytes32 invoiceNumber   = keccak256(utf8(normalizeRef(invoiceNumber)))
 *   ))
 *
 * normalizeRef = NFKC, upper-case, keep only [A-Z0-9]  ("inv-2026/0042" == "INV 2026 0042").
 * Due date / issue date are deliberately excluded: a re-sent invoice with a new due date
 * must map to the same id and be refused as a duplicate.
 */
export const PAYMENT_ID_TAG = keccak256(toBytes("PAYDAY_PAYMENT_ID_V1"));

export function normalizeRef(s: string): string {
  return s.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|inc|llc|enterprises?|nig|nigeria|co|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function computePaymentId(args: {
  chainId: number;
  policy: Address;
  payee: Address;
  amount: bigint;
  invoiceNumber: string;
}): Hex {
  const ref = normalizeRef(args.invoiceNumber);
  if (!ref) throw new Error("invoice number is empty after normalisation");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [PAYMENT_ID_TAG, BigInt(args.chainId), args.policy, args.payee, args.amount, keccak256(toBytes(ref))],
    ),
  );
}

/**
 * invoiceKey encoding (v1) - on-chain invoice dedup (audit L-01):
 *
 *   invoiceKey = keccak256(abi.encode(
 *     bytes32 tag            = keccak256("PAYDAY_INVOICE_KEY_V1"),
 *     uint256 chainId,
 *     address policy,
 *     address payee,          // from the allow-list
 *     bytes32 invoiceNumber   = keccak256(utf8(normalizeRef(invoiceNumber)))
 *   ))
 *
 * Unlike paymentId, the AMOUNT is excluded: a re-sent invoice with an altered amount maps to the
 * same key and SpendPolicy refuses it (InvoiceAlreadyUsed) while the first payment is Pending or
 * Executed. Computed by this code from the matched payee + extracted invoice number, never taken
 * from model output directly. It is released on chain only by owner reject or expiry.
 */
export const INVOICE_KEY_TAG = keccak256(toBytes("PAYDAY_INVOICE_KEY_V1"));

export function computeInvoiceKey(args: { chainId: number; policy: Address; payee: Address; invoiceNumber: string }): Hex {
  const ref = normalizeRef(args.invoiceNumber);
  if (!ref) throw new Error("invoice number is empty after normalisation");
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [INVOICE_KEY_TAG, BigInt(args.chainId), args.policy, args.payee, keccak256(toBytes(ref))],
    ),
  );
}

/** reasonHash = keccak256(utf8(canonicalJson(reasonDoc))). See README "Hash encodings". */
export function reasonHashOf(doc: unknown): { canonical: string; hash: Hex } {
  const canonical = canonicalJson(doc);
  return { canonical, hash: keccak256(toBytes(canonical)) };
}

/** Category label -> bytes32 (same as `cast format-bytes32-string`). */
export function categoryToBytes32(label: string): Hex {
  if (!/^[A-Z0-9_]{1,31}$/.test(label)) throw new Error("category must be 1-31 chars of A-Z, 0-9, _");
  return stringToHex(label, { size: 32 });
}

export function bytes32ToCategory(b: Hex): string {
  const bytes = toBytes(b);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

/**
 * Circle requires a UUID idempotency key. We derive it deterministically from the action
 * + paymentId so a retried request can never create a second Circle transaction.
 */
export function idempotencyKeyFor(action: string, paymentId: Hex, extra = ""): string {
  const h = keccak256(toBytes(`payday:${action}:${paymentId}:${extra}`)).slice(2, 34).split("");
  h[12] = "4"; // version 4 layout
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
