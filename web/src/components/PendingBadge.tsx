"use client";
import { useEffect, useState } from "react";
import { api } from "./api";

/** Count of payments parked on chain waiting for the owner. Polls every 30 s. */
export function PendingBadge() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => api<{ items: unknown[] }>("/api/approvals").then((r) => setN(r.items.length)).catch(() => setN(0));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (n === 0) return null;
  return (
    <span key={n} aria-label={`${n} pending approval${n === 1 ? "" : "s"}`}
      className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-saffron px-1.5 font-mono text-[0.7rem] font-semibold leading-none text-ink">
      {n}
    </span>
  );
}
