"use client";
import { useCallback, useEffect, useState } from "react";
import { useConfig, useConnection } from "wagmi";
import { connect, disconnect, signMessage } from "wagmi/actions";
import { injected } from "wagmi/connectors";
import { createSiweMessage } from "viem/siwe";
import { api } from "./api";
import { Button } from "./ui";

/** Wallet connect + Sign-In With Ethereum. Only the on-chain policy owner can sign in. */
export function Session() {
  const config = useConfig();
  const { address, isConnected } = useConnection();
  const [me, setMe] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<{ address: string }>("/api/auth/me").then((r) => setMe(r.address)).catch(() => setMe(null));
  }, []);
  useEffect(refresh, [refresh]);

  async function signIn() {
    setErr(null);
    try {
      let addr = address;
      if (!isConnected) addr = (await connect(config, { connector: injected() })).accounts[0];
      if (!addr) throw new Error("no wallet account");
      const n = await api<{ nonce: string; domain: string; uri: string; chainId: number }>("/api/auth/nonce");
      const message = createSiweMessage({
        address: addr,
        chainId: n.chainId,
        domain: n.domain,
        nonce: n.nonce,
        uri: n.uri,
        version: "1",
        statement: "Sign in to Payday as the business owner.",
      });
      const signature = await signMessage(config, { message });
      await api("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
      refresh();
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sign-in failed");
    }
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    await disconnect(config).catch(() => null);
    setMe(null);
    window.location.reload();
  }

  return (
    <div className="flex items-center gap-2">
      {me ? (
        <>
          <span title={me} className="hidden rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-xs text-ink-soft sm:inline-flex sm:items-center sm:gap-2">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-pay" />
            {me.slice(0, 6)}…{me.slice(-4)}
          </span>
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        </>
      ) : (
        <Button onClick={signIn}>Sign in</Button>
      )}
      {err && <span role="alert" className="max-w-48 truncate text-xs text-reject" title={err}>{err}</span>}
    </div>
  );
}
