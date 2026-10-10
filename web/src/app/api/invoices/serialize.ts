import type { InvoiceRow } from "@/lib/db";

/** What the owner UI sees for an invoice (no file bytes are ever stored). */
export function serializeInvoice(r: InvoiceRow) {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    extraction: r.extraction_json ? JSON.parse(r.extraction_json) : null,
    extractionError: r.extraction_error,
    injection: JSON.parse(r.injection_json),
    payeeAddress: r.payee_address,
    paymentId: r.payment_id,
    amountUnits: r.amount_units,
    dueDate: r.due_date,
    decision: r.decision,
    status: r.status,
    payOn: r.pay_on,
    reasonHash: r.reason_hash,
    explanation: r.explanation,
    txHash: r.tx_hash,
    milestone: r.milestone,
    lastError: r.last_error,
  };
}
