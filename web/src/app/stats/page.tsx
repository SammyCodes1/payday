import { publicStats } from "@/lib/events";
import { Address, Alert, Card, Empty, PageTitle, SectionTitle, Stat, explorer } from "@/components/ui";

export const dynamic = "force-dynamic";

const usdc = (u: string) => {
  const n = BigInt(u);
  return `${(n / 1_000_000n).toLocaleString("en-US")}.${(n % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
};

/** PUBLIC page. Counts ONLY on-chain PaymentExecuted events; nothing from the app DB. */
export default async function Stats() {
  let s;
  try {
    s = await publicStats();
  } catch {
    return <Alert tone="warn" title="Stats unavailable">The chain RPC is not reachable right now.</Alert>;
  }
  return (
    <>
      <PageTitle eyebrow="Public · on-chain only" title={<>Payments made <span className="text-teal-strong">through Payday</span></>}>
        Counted only from SpendPolicy <code className="rounded bg-fog px-1.5 py-0.5 font-mono text-[0.85em]">PaymentExecuted</code> events. Every row links to the explorer.
      </PageTitle>
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><Stat label="Payments" value={s.transactions} /></Card>
        <Card><Stat label="Volume" value={usdc(s.volumeUnits)} unit="USDC" /></Card>
        <Card><Stat label="Businesses" value={s.businesses} /></Card>
        <Card><Stat label="Distinct payees" value={s.payees} /></Card>
      </div>
      <Card as="section" className="rise mt-6" style={{ "--d": "200ms" } as React.CSSProperties}>
        <SectionTitle>Recent payments</SectionTitle>
        {s.recent.length === 0 ? (
          <Empty title="No payments yet" />
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="table">
              <thead><tr><th>Block</th><th>Business (policy)</th><th>Payee</th><th className="text-right">Amount</th><th>Transaction</th></tr></thead>
              <tbody>
                {s.recent.map((r) => (
                  <tr key={r.txHash + r.payee}>
                    <td className="tnum">{r.blockNumber}</td>
                    <td><Address value={r.policy} href={explorer.address(r.policy)} /></td>
                    <td><Address value={r.payee} href={explorer.address(r.payee)} /></td>
                    <td className="tnum whitespace-nowrap text-right">{usdc(r.amount)} USDC</td>
                    <td><Address value={r.txHash} chars={6} href={explorer.tx(r.txHash)} /></td>
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
