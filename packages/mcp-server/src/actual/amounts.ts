import * as api from '@actual-app/api';
import { getDecimalPlaces } from '@actual-app/core/shared/currencies';

export type AmountConverter = {
  decimalPlaces: number;
  /** Integer minor units (cents) from the Actual API -> major units (dollars). */
  toMajor: (minor: number) => number;
  /** Major units from a tool caller -> integer minor units for the Actual API. */
  toMinor: (major: number) => number;
  /** Fixed-precision text for human-readable output, e.g. `-12.30`. */
  format: (major: number) => string;
};

// Actual stores every amount as an integer scaled by the budget currency's
// decimal places (2 for USD, 0 for JPY, ...). Every tool talks in major units,
// and this is the only place that converts between the two.
export function createAmountConverter(currencyCode = ''): AmountConverter {
  const decimalPlaces = getDecimalPlaces(currencyCode);
  return {
    decimalPlaces,
    toMajor: minor => api.utils.integerToAmount(minor, decimalPlaces),
    toMinor: major => api.utils.amountToInteger(major, decimalPlaces) + 0,
    format: major => major.toFixed(decimalPlaces),
  };
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function isValidIsoMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && isValidIsoDate(`${value}-01`);
}

/** Today's date as `YYYY-MM-DD` in the machine's local time zone. */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
