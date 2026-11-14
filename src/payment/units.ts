const NEAR_DECIMALS = 24;

// Chains count integer atomic units. NEAR has 24 decimal places, so a domain amount of 0.02 is sent as 2e22 yoctoNEAR.
export function decimalToAtomic(symbol: string, amount: string): string | null {
  if (symbol !== "NEAR") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,24}))?$/.exec(amount);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(NEAR_DECIMALS, "0");
  return (BigInt(whole) * 10n ** BigInt(NEAR_DECIMALS) + BigInt(fraction)).toString();
}

export function nearOf(amount: string): bigint {
  const atomic = decimalToAtomic("NEAR", amount);
  if (atomic === null) throw new Error(`${amount} is not a NEAR amount`);
  return BigInt(atomic);
}

// Truncates rather than rounds, so a shown balance is never more than the account holds.
export function formatNear(yocto: bigint, digits = 4): string {
  const scale = 10n ** BigInt(NEAR_DECIMALS);
  const whole = yocto / scale;
  const fraction = (yocto % scale).toString().padStart(NEAR_DECIMALS, "0").slice(0, digits).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

// A domain unit is 1e-18 of the asset and a yoctoNEAR 1e-24, so a fee converts up: a budget check that rounds a fee
// down could let the real outflow pass the budget.
export function yoctoToUnits(yocto: bigint): bigint {
  return (yocto + 999_999n) / 1_000_000n;
}
