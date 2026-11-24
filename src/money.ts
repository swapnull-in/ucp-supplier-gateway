// ISO 4217 minor-unit exponents that differ from the default of 2.
const EXPONENTS: Record<string, number> = {
  BHD: 3, CLP: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KRW: 0, KWD: 3,
  LYD: 3, OMR: 3, PYG: 0, TND: 3, UGX: 0, VND: 0, XAF: 0, XOF: 0,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Converts a decimal major-unit amount (as legacy backends such as SAP OCC return it)
 * into integer minor units without going through floating-point multiplication.
 * Rejects values with more precision than the currency allows instead of silently rounding.
 */
export function toMinorUnits(value: number | string, currency: string): number {
  const text = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`Not a decimal amount: ${JSON.stringify(value)}`);
  const [, sign, whole, fraction = ""] = match;
  const exp = currencyExponent(currency);
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > exp) {
    throw new RangeError(`${text} has more precision than ${currency} allows (${exp} decimals)`);
  }
  const minor = BigInt(whole! + fraction.padEnd(exp, "0").slice(0, exp));
  const result = Number(sign ? -minor : minor);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Amount out of range: ${text}`);
  return result;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Not a finite amount: ${n}`);
  // toString() can produce exponent notation (1e-7); a fixed 12-digit form avoids that,
  // and trailing zeros are trimmed by the caller's precision check.
  return Math.abs(n) >= 1e21 ? n.toString() : n.toFixed(12).replace(/\.?0+$/, "");
}
