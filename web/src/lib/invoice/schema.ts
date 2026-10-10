import { z } from "zod";

/** Exact decimal amount as a string (never a float). Up to 6 decimals (USDC precision). */
export const DecimalString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,6})?$/, "amount must be a plain decimal like 1250.00");

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real calendar date");

export const LineItem = z
  .object({
    description: z.string().min(1).max(300),
    quantity: DecimalString,
    unitPrice: DecimalString,
    total: DecimalString,
  })
  .strict();

/**
 * The ONLY shape the extractor may return. Every field is required (nullable where optional)
 * so it works with strict structured-output modes. `otherText` holds every other piece of
 * text on the document verbatim, so we can screen it for prompt injection.
 */
export const InvoiceExtraction = z
  .object({
    payeeName: z.string().min(1).max(200).describe("Supplier / payee legal or trading name as printed"),
    payeeIdentifier: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .describe("Supplier identifier as printed: RC number, TIN, VAT ID or email. null if absent"),
    payeeBankDetails: z.string().max(200).nullable().describe("Bank name + account number exactly as printed, else null"),
    payeeWalletAddress: z.string().max(100).nullable().describe("Any crypto wallet address printed for payment, else null"),
    invoiceNumber: z.string().min(1).max(64),
    issueDate: IsoDate.nullable(),
    dueDate: IsoDate.nullable(),
    currency: z.string().regex(/^[A-Z]{3,5}$/, "ISO-style currency code, upper case"),
    amount: DecimalString.describe("Total amount due"),
    lineItems: z.array(LineItem).max(50),
    otherText: z.string().max(4000).describe("All remaining text on the document, verbatim, including notes"),
  })
  .strict();

export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>;

export function validateExtraction(raw: unknown):
  | { ok: true; value: InvoiceExtraction }
  | { ok: false; error: string } {
  const r = InvoiceExtraction.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}
