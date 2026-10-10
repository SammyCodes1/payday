"use client";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { isAddress, type Address } from "viem";
import { spendPolicyAbi } from "@/lib/abi";
import { categoryToBytes32 } from "@/lib/ids";
import { toUnits } from "@/lib/money";
import { api, fmtUsdc } from "@/components/api";
import { Address as Addr, Alert, Button, Card, PageTitle, SectionTitle, Spinner, Stat, StatusPill, explorer } from "@/components/ui";

interface Overview {
  policy: Address; owner: Address; agent: Address; paused: boolean; perPaymentCap: string; monthlyCap: string;
  globalCeiling: string; totalPaid: string; pendingTtl: string; spentInWindow: string; balance: string;
}
interface Payee {
  address: Address; label: string; categoryLabel: string; capUnits: string; allowedOnChain: boolean;
  identifiers: string[]; aliases: string[]; bankDetails: string | null; terms: unknown;
}

/** Owner-only controls. Every on-chain change is a transaction signed by YOUR wallet. */
export default function Settings() {
  const config = useConfig();
  const [o, setO] = useState<Overview | null>(null);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setO(await api<Overview>("/api/policy"));
      setPayees((await api<{ payees: Payee[] }>("/api/payees")).payees);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Each branch is a literal so viem/wagmi type-check the exact owner-only function and args.
  async function send(run: () => Promise<`0x${string}`>, what: string) {
    setMsg(`Confirm "${what}" in your wallet…`);
    try {
      const hash = await run();
      await waitForTransactionReceipt(config, { hash });
      setMsg(`${what}: confirmed (${hash})`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const policy = () => o!.policy;
  const form = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
  };

  if (!o) return msg ? <Alert tone="error">{msg}</Alert> : <Spinner label="Loading policy… (sign in as the owner)" />;
  const row = "flex flex-col gap-2 sm:flex-row sm:items-center";
  return (
    <>
      <PageTitle eyebrow="Owner controls" title="Payees & limits">
        Every on-chain change here is a transaction signed by your own wallet. The agent cannot change any of it.
      </PageTitle>
      {msg && <div className="mb-6"><Alert tone={/confirmed|saved/.test(msg) ? "success" : /Confirm/.test(msg) ? "info" : "error"}>{msg}</Alert></div>}

      <div className="stagger space-y-6">
        <Card as="section">
          <SectionTitle aside={<StatusPill value={o.paused ? "PAUSED" : "active"} />}>Policy</SectionTitle>
          <div className="grid gap-6 sm:grid-cols-3">
            <Stat label="Balance" value={fmtUsdc(o.balance).replace(" USDC", "")} unit="USDC" />
            <Stat label="Spent, rolling 30 days" value={fmtUsdc(o.spentInWindow).replace(" USDC", "")} unit="USDC" hint={`of ${fmtUsdc(o.monthlyCap)} monthly cap`} />
            <Stat label="Paid, lifetime" value={fmtUsdc(o.totalPaid).replace(" USDC", "")} unit="USDC" hint={`ceiling ${fmtUsdc(o.globalCeiling)}`} />
          </div>
          <dl className="mt-6 grid gap-2 border-t border-line pt-4 text-xs text-muted sm:grid-cols-3">
            <div>Contract <Addr value={o.policy} href={explorer.address(o.policy)} className="text-ink-soft" /></div>
            <div>Owner <Addr value={o.owner} className="text-ink-soft" /></div>
            <div>Agent <Addr value={o.agent} className="text-ink-soft" /></div>
          </dl>
          <div className="mt-5">
            {o.paused ? (
              <Button onClick={() => send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "unpause" }), "unpause")}>Unpause payments</Button>
            ) : (
              <Button variant="danger" onClick={() => send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "pause" }), "pause")}>Pause all payments</Button>
            )}
          </div>
        </Card>

        <Card as="section">
          <SectionTitle>Limits</SectionTitle>
          <p className="mb-5 text-sm text-muted">Per-payment {fmtUsdc(o.perPaymentCap)} · monthly {fmtUsdc(o.monthlyCap)} · pending approvals expire after {Number(o.pendingTtl) / 3600} h</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <form className={row} onSubmit={(e) => { const f = form(e); void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "setPerPaymentCap", args: [toUnits(f.v!)] }), "setPerPaymentCap"); }}>
              <input className="field flex-1" name="v" placeholder="Per-payment cap (USDC)" required /> <Button variant="secondary">Set per-payment cap</Button>
            </form>
            <form className={row} onSubmit={(e) => { const f = form(e); void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "setMonthlyCap", args: [toUnits(f.v!)] }), "setMonthlyCap"); }}>
              <input className="field flex-1" name="v" placeholder="Monthly cap (USDC)" required /> <Button variant="secondary">Set monthly cap</Button>
            </form>
            <form className={row} onSubmit={(e) => { const f = form(e); void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "setCategoryBudget", args: [categoryToBytes32(f.c!), toUnits(f.v!)] }), "setCategoryBudget"); }}>
              <input className="field sm:w-32" name="c" placeholder="Category" required /> <input className="field flex-1" name="v" placeholder="Budget (USDC)" required /> <Button variant="secondary">Set budget</Button>
            </form>
            <form className={row} onSubmit={(e) => { const f = form(e); void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "setPendingTtl", args: [BigInt(Math.round(Number(f.h) * 3600))] }), "setPendingTtl"); }}>
              <input className="field flex-1" name="h" placeholder="Pending TTL (hours)" required /> <Button variant="secondary">Set TTL</Button>
            </form>
          </div>
          <form className={`${row} mt-5 rounded-lg border border-reject/20 bg-reject-wash/40 p-3`} onSubmit={(e) => { const f = form(e); if (confirm("Lowering the lifetime ceiling is permanent. Continue?")) void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "lowerGlobalCeiling", args: [toUnits(f.v!)] }), "lowerGlobalCeiling"); }}>
            <input className="field flex-1" name="v" placeholder="New lifetime ceiling (USDC)" required /> <Button variant="danger">Lower ceiling (one-way)</Button>
          </form>
        </Card>

        <Card as="section">
          <SectionTitle>Allow-listed payees</SectionTitle>
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="table">
              <thead><tr><th>Payee</th><th>Category</th><th>Cap</th><th>On file</th><th>Agreed terms</th><th /></tr></thead>
              <tbody>
                {payees.map((p) => (
                  <tr key={p.address}>
                    <td><p className="font-medium text-ink">{p.label}</p><Addr value={p.address} href={explorer.address(p.address)} className="text-muted" />{!p.allowedOnChain && <StatusPill value="REJECTED" className="ml-2" />}</td>
                    <td className="font-mono text-xs">{p.categoryLabel}</td>
                    <td className="tnum whitespace-nowrap">{p.capUnits === "0" ? "none" : fmtUsdc(p.capUnits)}</td>
                    <td className="font-mono text-xs text-ink-soft">{p.identifiers.join(", ") || "–"}<br />{p.bankDetails ?? "–"}</td>
                    <td className="max-w-64 font-mono text-xs text-ink-soft">{p.terms ? JSON.stringify(p.terms) : <StatusPill value="pending" />}</td>
                    <td>{p.allowedOnChain && <Button variant="ghost" onClick={() => send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "removePayee", args: [p.address] }), "removePayee")}>Remove</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="font-display text-lg text-ink">Add or update on chain</h3>
              <p className="mb-3 mt-1 text-sm text-muted">This is the ONLY address the agent can pay this payee. Never copy it from an invoice; confirm it with the payee directly.</p>
              <form className="grid gap-2" onSubmit={(e) => {
                const f = form(e);
                if (!isAddress(f.a ?? "")) return setMsg("invalid address");
                void send(() => writeContract(config, { address: policy(), abi: spendPolicyAbi, functionName: "setPayee", args: [f.a as Address, f.l!, categoryToBytes32(f.c!), f.cap ? toUnits(f.cap) : 0n] }), "setPayee");
              }}>
                <input className="field font-mono" name="a" placeholder="0x… address" required />
                <div className="grid gap-2 sm:grid-cols-3">
                  <input className="field" name="l" placeholder="Label" required />
                  <input className="field" name="c" placeholder="Category" required />
                  <input className="field" name="cap" placeholder="Cap (blank = none)" />
                </div>
                <Button className="justify-self-start">Save payee on chain</Button>
              </form>
            </div>
            <div>
              <h3 className="font-display text-lg text-ink">Matching &amp; agreed terms</h3>
              <p className="mb-3 mt-1 text-sm text-muted">Kept in the app. Used to recognise invoices and check amounts; any change on an invoice escalates to you.</p>
              <form className="grid gap-2" onSubmit={(e) => {
                const f = form(e);
                let terms: unknown = null;
                try { terms = f.t ? JSON.parse(f.t) : null; } catch { return setMsg("terms must be JSON"); }
                void api("/api/payees", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    address: f.a, terms, bankDetails: f.b || null,
                    identifiers: (f.i ?? "").split(",").map((v) => v.trim()).filter(Boolean),
                    aliases: (f.al ?? "").split(",").map((v) => v.trim()).filter(Boolean),
                  }),
                }).then(() => { setMsg("saved"); return load(); }).catch((x: Error) => setMsg(x.message));
              }}>
                <select className="field" name="a">{payees.filter((p) => p.allowedOnChain).map((p) => <option key={p.address} value={p.address}>{p.label}</option>)}</select>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className="field" name="i" placeholder="Identifiers (RC / TIN), comma-separated" />
                  <input className="field" name="al" placeholder="Other names" />
                </div>
                <input className="field" name="b" placeholder="Bank details on file" />
                <input className="field font-mono text-xs" name="t" placeholder='Terms JSON, e.g. {"kind":"fixed","amount":"800.00"}' />
                <Button variant="secondary" className="justify-self-start">Save terms</Button>
              </form>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
