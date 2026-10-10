import Link from "next/link";
import { publicConfig } from "@/lib/public-config";

export function Card({ children, className = "", as: Tag = "div", style }: { children: React.ReactNode; className?: string; as?: "div" | "section" | "article"; style?: React.CSSProperties }) {
  return (
    <Tag style={style} className={`rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] min-[360px]:p-5 sm:p-6 ${className}`}>
      {children}
    </Tag>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
const base =
  "inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[0.9rem] font-medium tracking-[-0.005em] transition-[background-color,color,border-color,box-shadow,transform] duration-200 ease-[var(--ease-calm)] active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100";
const variants: Record<Variant, string> = {
  primary: "bg-teal-strong text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-teal-deep disabled:bg-fog disabled:text-muted disabled:shadow-none",
  accent: "bg-saffron text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.3)] hover:brightness-95 disabled:bg-fog disabled:text-muted",
  secondary: "border border-line-strong bg-surface text-ink hover:border-ink/40 hover:bg-white disabled:text-muted",
  ghost: "text-ink-soft hover:bg-fog/80 disabled:text-muted",
  danger: "border border-reject/30 bg-reject-wash text-reject hover:bg-reject hover:text-white disabled:opacity-50",
};

export function Button({ variant = "primary", loading, className = "", children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || loading} aria-busy={loading || undefined} className={`${base} ${variants[variant]} ${className}`}>
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "primary", className = "" }: { href: string; children: React.ReactNode; variant?: Variant; className?: string }) {
  return <Link href={href} className={`${base} ${variants[variant]} ${className}`}>{children}</Link>;
}

type Tone = "error" | "warn" | "info" | "success";
const tones: Record<Tone, { box: string; dot: string }> = {
  error: { box: "border-reject/25 bg-reject-wash/70 text-reject", dot: "bg-reject" },
  warn: { box: "border-ask/25 bg-ask-wash/70 text-ask", dot: "bg-saffron" },
  info: { box: "border-line bg-surface text-ink-soft", dot: "bg-teal" },
  success: { box: "border-pay/25 bg-pay-wash/70 text-pay", dot: "bg-pay" },
};
export function Alert({ tone = "info", title, children }: { tone?: Tone; title?: React.ReactNode; children: React.ReactNode }) {
  const t = tones[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`alert-in flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed ${t.box}`}>
      <span aria-hidden className={`mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Decision + status colours. Every tone is AA text-on-wash (see globals.css). */
const STATUS_TONE: Record<string, string> = {
  PAY_NOW: "bg-pay-wash text-pay", EXECUTED: "bg-pay-wash text-pay", verified: "bg-pay-wash text-pay", active: "bg-pay-wash text-pay",
  SCHEDULE: "bg-schedule-wash text-schedule", SCHEDULED: "bg-schedule-wash text-schedule",
  ASK: "bg-ask-wash text-ask", AWAITING_OWNER: "bg-ask-wash text-ask", ONCHAIN_PENDING: "bg-ask-wash text-ask", SUBMITTING: "bg-ask-wash text-ask", pending: "bg-ask-wash text-ask",
  ESCALATE: "bg-escalate-wash text-escalate", ESCALATED: "bg-escalate-wash text-escalate", injection: "bg-escalate-wash text-escalate",
  REJECT: "bg-reject-wash text-reject", REJECTED: "bg-reject-wash text-reject", FAILED: "bg-reject-wash text-reject",
  EXTRACTION_FAILED: "bg-reject-wash text-reject", PAUSED: "bg-reject-wash text-reject", mismatch: "bg-reject-wash text-reject",
};
const STATUS_LABEL: Record<string, string> = {
  PAY_NOW: "Pay now", SCHEDULE: "Schedule", ASK: "Ask owner", ESCALATE: "Escalate", REJECT: "Reject",
  EXECUTED: "Paid", SCHEDULED: "Scheduled", AWAITING_OWNER: "Needs you", ONCHAIN_PENDING: "Pending on chain", SUBMITTING: "Submitting",
  ESCALATED: "Escalated", pending: "Pending", verified: "Verified", injection: "Injection flagged", mismatch: "Hash mismatch", active: "Active", PAUSED: "Paused", REJECTED: "Rejected", FAILED: "Failed", DISMISSED: "Dismissed", EXTRACTION_FAILED: "Unreadable",
};
export function StatusPill({ value, className = "" }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className="text-muted">–</span>;
  return (
    <span title={value} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[0.75rem] font-medium leading-none ${STATUS_TONE[value] ?? "bg-fog text-ink-soft"} ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {STATUS_LABEL[value] ?? value}
    </span>
  );
}

export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`font-mono text-xs uppercase tracking-[0.16em] text-muted ${className}`}>{children}</p>;
}

export function PageTitle({ eyebrow, title, children }: { eyebrow?: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-8 sm:mb-10">
      {eyebrow && <Eyebrow className="mb-3">{eyebrow}</Eyebrow>}
      <h1 className="font-display text-[2rem] leading-[1.05] text-ink sm:text-[2.6rem]">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="font-display text-[1.35rem] leading-tight text-ink">{children}</h2>
      {aside}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-8 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-teal border-t-transparent" />
      {label}
    </div>
  );
}

export function Address({ value, chars = 4, href, className = "" }: { value: string; chars?: number; href?: string; className?: string }) {
  const short = value.length > chars * 2 + 5 ? `${value.slice(0, chars + 2)}…${value.slice(-chars)}` : value;
  const inner = <span title={value} className={`font-mono text-[max(12px,0.82em)] tracking-tight ${className}`}>{short}</span>;
  return href ? <a href={href} target="_blank" rel="noreferrer" className="underline decoration-current/30 underline-offset-[3px] hover:decoration-current">{inner}</a> : inner;
}

export const explorer = {
  tx: (h: string) => `${publicConfig.explorerUrl}/tx/${h}`,
  address: (a: string) => `${publicConfig.explorerUrl}/address/${a}`,
};

export function Stat({ label, value, unit, hint, className = "" }: { label: string; value: React.ReactNode; unit?: string; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-[0.78rem] text-muted">{label}</p>
      <p className="font-numeral mt-1 text-[1.75rem] leading-none text-ink">
        {value}
        {unit && <span className="ml-1.5 font-sans text-sm font-medium text-muted">{unit}</span>}
      </p>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="font-display text-lg text-ink">{title}</p>
      {children && <p className="mt-1.5 text-sm text-muted">{children}</p>}
    </div>
  );
}
