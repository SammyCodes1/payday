export interface InvoiceDto {
  id: string;
  createdAt: string;
  fileName: string;
  fileSha256: string;
  extraction: {
    payeeName: string;
    payeeIdentifier: string | null;
    payeeBankDetails: string | null;
    payeeWalletAddress: string | null;
    invoiceNumber: string;
    issueDate: string | null;
    dueDate: string | null;
    currency: string;
    amount: string;
    lineItems: { description: string; quantity: string; unitPrice: string; total: string }[];
    otherText: string;
  } | null;
  extractionError: string | null;
  injection: { rule: string; field: string; match: string }[];
  payeeAddress: string | null;
  paymentId: string | null;
  amountUnits: string | null;
  decision: string | null;
  status: string;
  payOn: string | null;
  reasonHash: string | null;
  explanation: string | null;
  txHash: string | null;
  lastError: string | null;
}
