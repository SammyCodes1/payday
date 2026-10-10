"use client";
import { useEffect, useState } from "react";
import { api, fmtUsdc } from "@/components/api";
import { Address, Alert, Card, Empty, PageTitle, Skeleton, StatusPill, explorer } from "@/components/ui";

interface Entry {
  eventName: string; paymentId: string; reasonHash: string; blockNumber: string; txHash: string; payee: string | null;
  amount: string | null; extra: Record<string, string>; verified: boolean;
  reasonDoc: { decision?: string; reasons?: { code: string; outcome: string }[]; invoice?: { invoiceNumber?: string; payeeName?: string } } | null;
}

export default function Log() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ entries: Entry[] }>("/api/log").then((r) => setEntries(r.entries)).catch((e: Error) => { setEntries([]); setErr(e.message); });
  }, []);
  const ZERO = "0x" + "0".repeat(64);
  return (
    <>
      <PageTitle eyebrow="Audit trail" title="Decision log">
        Rebuilt from SpendPolicy events on chain. <strong className="font-medium text-ink">Verified</strong> means keccak256 of the stored reason JSON equals the reasonHash the contract recorded.
      </PageTitle>
      {err && <div className="mb-6"><Alert tone="error">{err}</Alert></div>}
      <Card as="section">
        {entries === null ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : entries.length === 0 ? (
          <Empty title="No payment events yet" />
        ) : (
          <div className="content-in -mx-4 overflow-x-auto sm:mx-0">
            <table className="table">
              <thead><tr><th>Block</th><th>Event</th><th>Invoice</th><th className="text-right">Amount</th><th>Decision</th><th>Reasons</th><th>Reason JSON</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={`${e.txHash}-${e.eventName}-${e.paymentId}`}>
                    <td><a className="tnum underline decoration-current/30 underline-offset-[3px] hover:decoration-current" href={explorer.tx(e.txHash)} target="_blank" rel="noreferrer">{e.blockNumber}</a></td>
                    <td className="font-mono text-xs text-ink">{e.eventName.replace("Payment", "")}</td>
                    <td>{e.reasonDoc?.invoice?.payeeName ?? "–"}<div className="font-mono text-xs text-muted">{e.reasonDoc?.invoice?.invoiceNumber ?? ""}</div>{e.payee && <Address value={e.payee} className="text-muted" />}</td>
                    <td className="tnum whitespace-nowrap text-right">{fmtUsdc(e.amount)}</td>
                    <td><StatusPill value={e.reasonDoc?.decision} /></td>
                    <td className="max-w-64 font-mono text-xs text-muted">{e.reasonDoc?.reasons?.map((r) => r.code).join(", ")}</td>
                    <td>{e.verified ? <StatusPill value="verified" /> : e.reasonHash === ZERO ? <span className="text-xs text-muted">none</span> : <StatusPill value="mismatch" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
