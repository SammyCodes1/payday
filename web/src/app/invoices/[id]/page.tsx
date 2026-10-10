"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api, fmtUsdc } from "@/components/api";
import type { InvoiceDto } from "@/components/types";
import { Address, Alert, Button, Card, Eyebrow, LinkButton, SectionTitle, Spinner, StatusPill, explorer } from "@/components/ui";

interface Reason { code: string; outcome: string; detail: Record<string, unknown> }

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [inv, setInv] = useState<InvoiceDto | null>(null);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ invoice: InvoiceDto; reasonDoc: { reasons: Reason[] } | null }>(`/api/invoices/${id}`);
      setInv(r.invoice);
      setReasons(r.reasonDoc?.reasons ?? []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(action: "confirm" | "reevaluate" | "dismiss") {
    setErr(null);
    setBusy(action);
    try {
      await api(`/api/invoices/${id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!inv) return err ? <Alert tone="error">{err}</Alert> : <Spinner label="Loading invoice…" />;
  const x = inv.extraction;
  const flags = inv.injection.filter((f) => f.rule !== "evm-address");
  return (
    <div className="stagger space-y-6">
      <div>
        <LinkButton href="/" variant="ghost" className="-ml-3 mb-4">← Inbox</LinkButton>
        <Eyebrow className="mb-3">Invoice {x?.invoiceNumber ?? ""}</Eyebrow>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="font-display text-[2rem] leading-[1.05] text-ink sm:text-[2.4rem]">{x?.payeeName ?? inv.fileName}</h1>
          <p className="font-numeral text-[2rem] leading-none text-ink">{fmtUsdc(inv.amountUnits)}</p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2"><StatusPill value={inv.decision} /><StatusPill value={inv.status} /></div>
      </div>

      <Card as="section">
        <SectionTitle>Why</SectionTitle>
        <p className="max-w-3xl leading-relaxed text-ink-soft">{inv.explanation}</p>
        <p className="mt-2 text-xs text-muted">The decision is made by deterministic rules; this explanation is AI-written and advisory only.</p>
        <div className="mt-4 space-y-3">
          {inv.payOn && <Alert tone="info" title="Scheduled">Will be re-checked and paid on <strong>{inv.payOn}</strong>.</Alert>}
          {inv.txHash && <Alert tone="success" title="On chain">Transaction <Address value={inv.txHash} chars={6} href={explorer.tx(inv.txHash)} /></Alert>}
          {inv.lastError && <Alert tone="error">{inv.lastError}</Alert>}
          {err && <Alert tone="error">{err}</Alert>}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {inv.status === "AWAITING_OWNER" && <Button loading={busy === "confirm"} onClick={() => act("confirm")}>Confirm &amp; pay</Button>}
          {["ESCALATED", "FAILED", "SCHEDULED", "AWAITING_OWNER", "REJECTED"].includes(inv.status) && (
            <Button variant="secondary" loading={busy === "reevaluate"} onClick={() => act("reevaluate")}>Re-evaluate</Button>
          )}
          {!["EXECUTED", "ONCHAIN_PENDING", "DISMISSED"].includes(inv.status) && (
            <Button variant="danger" loading={busy === "dismiss"} onClick={() => act("dismiss")}>Dismiss</Button>
          )}
        </div>
      </Card>

      {flags.length > 0 && (
        <Card as="section" className="border-escalate/30 bg-escalate-wash/40">
          <SectionTitle aside={<StatusPill value="injection" />}>Suspicious text in this invoice</SectionTitle>
          <p className="mb-4 text-sm text-ink-soft">This text was treated as data. The agent has no tools, and the payee address comes only from your on-chain allow-list.</p>
          <ul className="space-y-2">
            {inv.injection.map((f, i) => (
              <li key={i} className="rounded-lg border border-escalate/25 bg-surface px-4 py-3">
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.12em] text-escalate">{f.rule} · {f.field}</p>
                <p className="mt-1 whitespace-pre-wrap font-mono text-sm text-ink">“{f.match}”</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card as="section" className="min-w-0">
          <SectionTitle>Checks</SectionTitle>
          <ul className="divide-y divide-line">
            {reasons.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="font-mono text-[0.8rem] text-ink">{r.code}</p>
                  {Object.keys(r.detail).length > 0 && <p className="mt-0.5 break-words font-mono text-xs text-muted">{JSON.stringify(r.detail)}</p>}
                </div>
                <StatusPill value={r.outcome} />
              </li>
            ))}
          </ul>
          <dl className="mt-5 space-y-1 border-t border-line pt-4 text-xs text-muted">
            <div className="flex gap-2"><dt className="w-24 shrink-0">paymentId</dt><dd className="break-all font-mono">{inv.paymentId ?? "–"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0">reasonHash</dt><dd className="break-all font-mono">{inv.reasonHash ?? "–"}</dd></div>
          </dl>
        </Card>

        <Card as="section" className="min-w-0">
          <SectionTitle>Extracted fields</SectionTitle>
          {inv.extractionError && <Alert tone="error">{inv.extractionError}</Alert>}
          {x && (
            <dl className="divide-y divide-line text-sm">
              {([
                ["Payee", x.payeeName], ["Identifier", x.payeeIdentifier], ["Bank details on invoice", x.payeeBankDetails],
                ["Wallet on invoice (ignored)", x.payeeWalletAddress], ["Invoice no.", x.invoiceNumber], ["Due", x.dueDate],
                ["Amount", `${x.amount} ${x.currency}`],
              ] as const).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted">{k}</dt><dd className="break-words text-ink">{v ?? "–"}</dd></div>
              ))}
              <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <dt className="text-muted">Paying to (from chain)</dt>
                <dd>{inv.payeeAddress ? <Address value={inv.payeeAddress} chars={6} href={explorer.address(inv.payeeAddress)} /> : "–"}</dd>
              </div>
              {x.otherText && <div className="py-2.5"><dt className="mb-1 text-muted">Other text</dt><dd className="whitespace-pre-wrap rounded-lg bg-mist px-3 py-2 font-mono text-xs text-ink-soft">{x.otherText}</dd></div>}
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
