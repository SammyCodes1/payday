/** Payday mark: a ledger tick inside a rounded square (original artwork). */
export function PaydayMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--color-teal-strong)" />
      <path d="M8 11.5h16M8 16h9" stroke="#fff" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
      <path d="m15.5 21 3 3 6-7" fill="none" stroke="var(--color-saffron)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
