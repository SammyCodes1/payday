"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtUsdc } from "@/components/api";
import type { InvoiceDto } from "@/components/types";
import { Alert, Button, Card, Empty, PageTitle, SectionTitle, Skeleton, StatusPill } from "@/components/ui";

export default function Inbox() {
  const [items, setItems] = useState<InvoiceDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const load = useCallback(() => {
    api<{ invoices: InvoiceDto[] }>("/api/invoices").then((r) => setItems(r.invoices)).catch((e: Error) => { setItems([]); setErr(e.message); });
  }, []);
  useEffect(load, [load]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api("/api/invoices", { method: "POST", body: new FormData(e.currentTarget) });
      formRef.current?.reset();
      setFileName(null);
      load();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needsYou = items?.filter((i) => ["AWAITING_OWNER", "ONCHAIN_PENDING", "ESCALATED"].includes(i.status)).length ?? 0;

  return (
    <>
      <PageTitle eyebrow="Accounts payable" title={<>Invoices in. <span className="text-teal-strong">Payments out.</span></>}>
        Drop an invoice and the agent reads it, checks it against your agreed terms and on-chain limits, and either pays,
        schedules, or asks you. It can only ever pay addresses on your allow-list.
      </PageTitle>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card as="section" className="rise h-fit min-w-0">
          <SectionTitle>Upload an invoice</SectionTitle>
          <form ref={formRef} onSubmit={upload} className="flex flex-col gap-4">
            <label className="lift flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-mist/60 px-4 py-8 text-center hover:border-teal">
              <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-wash font-display text-xl text-teal-strong">↑</span>
              <span className="text-sm font-medium text-ink">{fileName ?? "Choose a PDF or photo"}</span>
              <span className="text-xs text-muted">PDF, PNG, JPEG or WebP · max 5 MB</span>
              <input className="sr-only" type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required
                onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)} />
            </label>
            <Button loading={busy} disabled={!fileName}>{busy ? "Reading invoice…" : "Upload & decide"}</Button>
          </form>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Invoice text is treated as data, never as instructions. Suspicious wording is flagged and shown to you.
          </p>
          {err && <div className="mt-4"><Alert tone="error">{err}</Alert></div>}
        </Card>

        <Card as="section" className="rise min-w-0" style={{ "--d": "80ms" } as React.CSSProperties}>
          <SectionTitle aside={needsYou > 0 ? <StatusPill value="AWAITING_OWNER" /> : undefined}>Recent invoices</SectionTitle>
          {items === null ? (
            <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : items.length === 0 ? (
            <Empty title="No invoices yet">Upload one to see the agent&apos;s decision.</Empty>
          ) : (
            <div className="content-in -mx-4 overflow-x-auto sm:mx-0">
              <table className="table">
                <thead><tr><th>Payee</th><th>Invoice</th><th className="text-right">Amount</th><th>Decision</th><th>Status</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`/invoices/${i.id}`} className="font-medium text-ink underline-offset-[3px] hover:underline">{i.extraction?.payeeName ?? i.fileName}</Link>
                        <div className="mt-0.5 text-xs text-muted">{new Date(i.createdAt).toLocaleString()}</div>
                        {i.injection.some((f) => f.rule !== "evm-address") && <StatusPill value="injection" className="mt-1.5" />}
                      </td>
                      <td className="font-mono text-xs text-ink-soft">{i.extraction?.invoiceNumber ?? "–"}</td>
                      <td className="tnum whitespace-nowrap text-right">{fmtUsdc(i.amountUnits)}</td>
                      <td><StatusPill value={i.decision} /></td>
                      <td><StatusPill value={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
