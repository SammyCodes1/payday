"use client";
import { useEffect, useState } from "react";
import { useConfig, useConnection } from "wagmi";
import { connect, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { injected } from "wagmi/connectors";
import { getAddress, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { spendPolicyFactoryAbi } from "@/lib/factory-abi";
import { toUnits } from "@/lib/money";
import { api } from "@/components/api";
import { Address as Addr, Alert, Button, Card, PageTitle, SectionTitle, Spinner, explorer } from "@/components/ui";

interface OnboardingConfig {
  chainId: number;
  factory: Address | null;
  token: Address;
  hostedAgent: Address | null;
  defaults: { perPaymentUsdc: string; monthlyUsdc: string; ceilingUsdc: string; ttlDays: number };
  existing: { policy: Address; agent: Address } | null;
}

/**
 * "Create my policy": each business deploys ITS OWN SpendPolicy through the factory, signed by
 * its own wallet, which becomes the owner. Nobody else's wallet (incl. Payday's deployer) is involved.
 */
export default function Onboarding() {
  const config = useConfig();
  const { address, isConnected } = useConnection();
  const [cfg, setCfg] = useState<OnboardingConfig | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ policy: Address; tx: Hex } | null>(null);

  useEffect(() => {
    const q = address ? `?owner=${address}` : "";
    api<OnboardingConfig>(`/api/tenants${q}`)
      .then(setCfg)
      .catch((e: Error) => setMsg({ tone: "error", text: e.message }));
  }, [address]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cfg?.factory) return;
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setMsg(null);
    try {
      let owner = address;
      if (!isConnected) owner = (await connect(config, { connector: injected() })).accounts[0];
      if (!owner) throw new Error("no wallet account");
      const agent = (f.agent ?? "").trim();
      if (!isAddress(agent)) throw new Error("agent must be a 0x address");
      if (getAddress(agent) === getAddress(owner)) throw new Error("use a different wallet for the agent than your owner wallet");
      const per = toUnits(f.per!);
      const month = toUnits(f.month!);
      const ceil = toUnits(f.ceil!);
      if (per === 0n || month === 0n || ceil === 0n) throw new Error("caps must be greater than 0");
      if (per > month) throw new Error("per-payment cap cannot exceed the monthly cap");
      if (month > ceil) throw new Error("monthly cap cannot exceed the lifetime ceiling");
      const ttl = BigInt(Math.round(Number(f.ttl) * 86_400));

      await switchChain(config, { chainId: cfg.chainId as never }).catch(() => null);
      setMsg({ tone: "info", text: "Confirm the transaction in your wallet. Your wallet becomes the policy owner." });
      const tx = await writeContract(config, {
        address: cfg.factory,
        abi: spendPolicyFactoryAbi,
        functionName: "createPolicy",
        args: [getAddress(agent), per, month, ceil, ttl],
      });
      setMsg({ tone: "info", text: "Waiting for confirmation…" });
      const receipt = await waitForTransactionReceipt(config, { hash: tx });
      const ev = parseEventLogs({ abi: spendPolicyFactoryAbi, logs: receipt.logs, eventName: "PolicyCreated" }).find(
        (l) => getAddress(l.address) === getAddress(cfg.factory!),
      );
      if (!ev) throw new Error("PolicyCreated event not found in the receipt");
      const policy = ev.args.policy;
      await api("/api/tenants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy, txHash: tx }) });
      setCreated({ policy, tx });
      setMsg({ tone: "success", text: "Your policy is live and linked to your wallet. Sign in (top right) to manage it." });
    } catch (err) {
      setMsg({ tone: "error", text: (err as { shortMessage?: string }).shortMessage ?? (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return msg ? <Alert tone="error">{msg.text}</Alert> : <Spinner label="Loading…" />;
  const d = cfg.defaults;
  return (
    <>
      <PageTitle eyebrow="New business" title="Create my policy">
        Payday never holds your money. You deploy your own SpendPolicy contract from your own wallet: you are its owner,
        the AI agent can only ask it to pay allow-listed payees within the caps you set here.
      </PageTitle>
      {msg && <div className="mb-6"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {!cfg.factory && (
        <div className="mb-6"><Alert tone="info" title="Not available yet">The Payday policy factory has not been deployed on this network yet.</Alert></div>
      )}

      {cfg.existing && !created && (
        <div className="mb-6">
          <Alert tone="info" title="You already have a policy">
            <Addr value={cfg.existing.policy} href={explorer.address(cfg.existing.policy)} /> is linked to this wallet. Sign in to manage it.
            Creating another one replaces the link.
          </Alert>
        </div>
      )}

      {created ? (
        <Card as="section">
          <SectionTitle>Next steps</SectionTitle>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-soft">
            <li>Policy: <Addr value={created.policy} href={explorer.address(created.policy)} /> (tx <Addr value={created.tx} href={explorer.tx(created.tx)} />)</li>
            <li>Sign in with this wallet (top right).</li>
            <li>In <a className="underline" href="/settings">Payees &amp; limits</a>: add payees, set category budgets, and deposit USDC.</li>
          </ol>
        </Card>
      ) : (
        <Card as="section">
          <SectionTitle>Your policy</SectionTitle>
          <form className="grid gap-4" onSubmit={create}>
            <label className="grid gap-1 text-sm">
              <span className="text-ink-soft">Agent address (the key that requests payments)</span>
              <input className="field font-mono" name="agent" defaultValue={cfg.hostedAgent ?? ""} placeholder="0x…" required />
              <span className="text-xs text-muted">
                {cfg.hostedAgent
                  ? "Pre-filled with Payday's hosted agent so invoices you upload get processed automatically. It can never exceed your caps or change your settings. You can replace it any time (setAgent)."
                  : "Must be different from your owner wallet."}
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-4">
              <label className="grid gap-1 text-sm"><span className="text-ink-soft">Per payment (USDC)</span><input className="field" name="per" defaultValue={d.perPaymentUsdc} required /></label>
              <label className="grid gap-1 text-sm"><span className="text-ink-soft">Monthly (USDC)</span><input className="field" name="month" defaultValue={d.monthlyUsdc} required /></label>
              <label className="grid gap-1 text-sm"><span className="text-ink-soft">Lifetime ceiling (USDC)</span><input className="field" name="ceil" defaultValue={d.ceilingUsdc} required /></label>
              <label className="grid gap-1 text-sm"><span className="text-ink-soft">Approval window (days)</span><input className="field" name="ttl" type="number" min={1} max={90} defaultValue={d.ttlDays} required /></label>
            </div>
            <p className="text-xs text-muted">
              Owner: {address ? <Addr value={address} /> : "your connected wallet"}. Gas is paid in USDC on Arc. The lifetime ceiling can only be lowered later.
            </p>
            <div><Button loading={busy} disabled={busy || !cfg.factory}>{isConnected ? "Create my policy" : "Connect wallet & create"}</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
