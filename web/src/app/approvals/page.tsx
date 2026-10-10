"use client";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { signTypedData, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Address, Hex } from "viem";
import { spendPolicyAbi } from "@/lib/abi";
import { bytes32ToCategory } from "@/lib/ids";
import { APPROVE_TYPES, approvalMessage } from "@/lib/eip712";
import { api, fmtUsdc } from "@/components/api";
import { Address as Addr, Alert, Button, Card, Empty, PageTitle, StatusPill, explorer } from "@/components/ui";

interface Item {
  paymentId: Hex; payee: Address; amount: string; category: Hex; reasonHash: Hex; overLimits: number; expiresAt: string; blockedReason: string | null;
  expired: boolean; invoiceId: string | null; fileName: string | null; title: string | null; explanation: string | null; txHash: Hex;
}
interface Resp {
  policy: Address; chainId: number; eip712: { name: string; version: string; chainId: number; verifyingContract: Address };
  ownerEpoch: string; openPending: string; maxOpenPending: string; items: Item[];
}

const LIMIT_NAMES: [number, string][] = [[1, "per-payment cap"], [2, "monthly cap"], [4, "category budget"], [8, "payee cap"]];

/** Random 128-bit nonce (single-use on chain) and a 1-hour signature deadline. */
function freshNonceAndDeadline() {
  const nonce = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  return { nonce, deadline };
}

export default function Approvals() {
  const config = useConfig();
  const [data, setData] = useState<Resp | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<Resp>("/api/approvals").then(setData).catch((e: Error) => setMsg(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  async function approveTx(it: Item) {
    setMsg("Confirm the approvePending transaction in your wallet…");
    try {
      const hash = await writeContract(config, { address: data!.policy, abi: spendPolicyAbi, functionName: "approvePending", args: [it.paymentId] });
      await waitForTransactionReceipt(config, { hash });
      setMsg(`Approved on chain: ${hash}`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function approveSig(it: Item) {
    setMsg("Sign the EIP-712 approval in your wallet (no gas)…");
    try {
      const { nonce, deadline } = freshNonceAndDeadline();
      const signature = await signTypedData(config, {
        domain: data!.eip712,
        types: APPROVE_TYPES,
        primaryType: "ApprovePending",
        message: approvalMessage(
          { paymentId: it.paymentId, payee: it.payee, amount: BigInt(it.amount), category: it.category, reasonHash: it.reasonHash, expiresAt: BigInt(it.expiresAt) },
          BigInt(data!.ownerEpoch),
          nonce,
          deadline,
        ),
      });
      const r = await api<{ txHash: string; outcome: string }>("/api/approvals/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId: it.paymentId, nonce: nonce.toString(), deadline: deadline.toString(), signature }),
      });
      setMsg(`Relayed by the agent wallet: ${r.outcome} (${r.txHash})`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function reject(it: Item) {
    setMsg("Confirm the rejectPending transaction in your wallet…");
    try {
      const hash = await writeContract(config, { address: data!.policy, abi: spendPolicyAbi, functionName: "rejectPending", args: [it.paymentId] });
      await waitForTransactionReceipt(config, { hash });
      setMsg(`Rejected on chain: ${hash}`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <>
      <PageTitle eyebrow="Owner approvals" title={<>Waiting for <span className="text-teal-strong">you</span>{data && data.items.length > 0 && <span className="badge-pop ml-3 inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-saffron px-2.5 align-middle font-mono text-base text-ink">{data.items.length}</span>}</>}>
        These payments exceeded a limit, so the SpendPolicy contract parked them. Only your wallet can release them:
        sign an approval (the agent relays it, gas sponsored) or send the transaction yourself.
      </PageTitle>
      {msg && <div className="mb-6"><Alert tone={/^(Approved|Rejected|Relayed)/.test(msg) ? "success" : /Confirm|Sign/.test(msg) ? "info" : "error"}>{msg}</Alert></div>}
      {data && BigInt(data.openPending) >= BigInt(data.maxOpenPending) && (
        <div className="mb-6"><Alert tone="error">The approval queue is full ({data.openPending}/{data.maxOpenPending}). The agent cannot park new over-limit payments until you approve or reject some.</Alert></div>
      )}
      {data && data.items.length === 0 && <Empty title="Nothing waiting for you">Over-limit payments will appear here.</Empty>}
      <div className="stagger grid gap-4">
        {data?.items.map((it) => (
          <Card key={it.paymentId} as="article" className="lift">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill value={it.expired ? "REJECTED" : "pending"} />
                  {LIMIT_NAMES.filter(([b]) => it.overLimits & b).map(([, n]) => (
                    <span key={n} className="rounded-full bg-fog px-2.5 py-[3px] text-[0.75rem] font-medium leading-none text-ink-soft">over {n}</span>
                  ))}
                </div>
                <h2 className="font-display mt-3 text-[1.35rem] leading-tight text-ink">
                  {it.invoiceId ? <a href={`/invoices/${it.invoiceId}`} className="hover:underline">{it.title ?? it.fileName}</a> : <Addr value={it.paymentId} chars={6} />}
                </h2>
                {it.blockedReason && <div className="mt-3"><Alert tone="error">{it.blockedReason}</Alert></div>}
                {it.explanation && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{it.explanation}</p>}
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                  <div>Payee <Addr value={it.payee} href={explorer.address(it.payee)} className="text-ink-soft" /></div>
                  <div>Category <span className="font-mono text-ink-soft">{bytes32ToCategory(it.category)}</span></div>
                  <div>Expires <span className="text-ink-soft">{new Date(Number(it.expiresAt) * 1000).toLocaleString()}</span></div>
                </dl>
              </div>
              <p className="font-numeral text-[1.75rem] leading-none text-ink">{fmtUsdc(it.amount)}</p>
            </div>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button disabled={it.expired || !!it.blockedReason} onClick={() => approveSig(it)} title="Sign EIP-712; the agent relays it (gas sponsored)">Approve with signature</Button>
              <Button variant="secondary" disabled={it.expired || !!it.blockedReason} onClick={() => approveTx(it)}>Approve with transaction</Button>
              <Button variant="danger" onClick={() => reject(it)}>Reject</Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
