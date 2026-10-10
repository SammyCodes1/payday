import { handle, HttpError, json, requireOwner } from "@/lib/auth/guard";
import { serverConfig } from "@/lib/config";
import { getInvoice, listInvoices } from "@/lib/db";
import { UploadError } from "@/lib/invoice/upload";
import { evaluateInvoice, intakeUpload } from "@/lib/pipeline";
import { serializeInvoice } from "./serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = handle(async (req) => {
  await requireOwner(req);
  return json({ invoices: listInvoices().map(serializeInvoice) });
});

export const POST = handle(async (req) => {
  await requireOwner(req, "upload");
  const max = serverConfig().PAYDAY_MAX_UPLOAD_BYTES;
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max + 64 * 1024) throw new HttpError(413, "upload too large");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "expected multipart field 'file'");
  if (file.size > max) throw new HttpError(413, "upload too large");
  try {
    const id = await intakeUpload({ bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type, fileName: file.name });
    await evaluateInvoice(id);
    return json({ invoice: serializeInvoice(getInvoice(id)!) }, { status: 201 });
  } catch (e) {
    if (e instanceof UploadError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
