export function Footer() {
  return (
    <footer className="border-t border-line/80 pb-24 pt-8 md:pb-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>Payday · every payment is bounded by an on-chain SpendPolicy you control.</p>
        <p className="font-mono uppercase tracking-[0.12em]">Agent decides · contract enforces · you approve</p>
      </div>
    </footer>
  );
}
