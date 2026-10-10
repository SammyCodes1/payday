/** USDC on Arc's ERC-20 interface has 6 decimals. All app amounts are bigint "units". */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
const DECIMAL_RE = /^(\d{1,15})(?:\.(\d{1,6}))?$/;

/** Exact decimal string -> units. No floats anywhere. Throws on anything else. */
export function toUnits(decimal: string): bigint {
  const m = DECIMAL_RE.exec(decimal.trim());
  if (!m) throw new Error(`not a USDC amount: ${JSON.stringify(decimal)}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * SCALE + frac;
}

export function formatUnits6(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** quantity * unitPrice, both exact decimals, result in units (rounded down to 1e-6). */
export function mulDecimal(quantity: string, unitPrice: string): bigint {
  return (toUnits(quantity) * toUnits(unitPrice)) / SCALE;
}
