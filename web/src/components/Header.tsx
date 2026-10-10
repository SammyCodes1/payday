"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PaydayMark } from "./Brand";
import { PendingBadge } from "./PendingBadge";
import { Session } from "./Session";
import { publicConfig } from "@/lib/public-config";

export const NAV = [
  { href: "/", label: "Inbox" },
  { href: "/approvals", label: "Approvals", badge: true },
  { href: "/settings", label: "Payees & limits", short: "Limits" },
  { href: "/log", label: "Decision log", short: "Log" },
  { href: "/stats", label: "Public stats", short: "Stats" },
] as const;

export function isActive(path: string, href: string) {
  return href === "/" ? path === "/" || path.startsWith("/invoices") : path.startsWith(href);
}

export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line/80 bg-mist/80 shadow-[var(--shadow-raised)] backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-8">
        <Link href="/" className="group flex min-h-11 min-w-0 items-center gap-2.5" aria-label="Payday home">
          <PaydayMark className="h-8 w-8 shrink-0 transition-transform duration-500 ease-[var(--ease-calm)] group-hover:-rotate-6" />
          <span className="font-display hidden text-[1.25rem] leading-none text-ink min-[360px]:inline sm:text-[1.3rem]">Payday</span>
          <span className="rounded-full border border-saffron/60 bg-saffron-wash/80 px-2 py-1 font-mono text-xs font-medium uppercase leading-none tracking-[0.1em] text-saffron-deep">
            {publicConfig.chain === "anvil" ? "Local" : "Testnet"}
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((n) => {
            const active = isActive(path, n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                className={`relative inline-flex min-h-11 items-center rounded-lg px-3 text-[0.9rem] transition-colors ${active ? "text-ink" : "text-muted hover:text-ink"}`}>
                {n.label}
                {"badge" in n && <PendingBadge />}
                <span className={`absolute inset-x-3 -bottom-[10px] h-[2px] rounded-full bg-teal transition-opacity ${active ? "opacity-100" : "opacity-0"}`} />
              </Link>
            );
          })}
        </nav>
        <Session />
      </div>
    </header>
  );
}

/** Bottom tab bar for phones/tablets (< md). */
export function MobileNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-[var(--z-sticky)] border-t border-line/80 bg-mist/85 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-18px_rgb(19_32_30/0.3)] backdrop-blur-md backdrop-saturate-150 md:hidden">
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {NAV.map((n) => {
          const active = isActive(path, n.href);
          return (
            <li key={n.href}>
              <Link href={n.href} aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.72rem] font-medium ${active ? "text-teal-strong" : "text-muted"}`}>
                <span className={`absolute inset-x-5 top-0 h-[2px] rounded-full bg-teal transition-opacity ${active ? "opacity-100" : "opacity-0"}`} />
                <span className="flex items-center">{"short" in n ? n.short : n.label}{"badge" in n && <PendingBadge />}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
