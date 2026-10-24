import type { AmountConverter } from '#actual/amounts';

import { addDays, addMonthsToDay, daysBetween } from './dates';
import { mean, median, roundMinor, stdev } from './statistics';
import { classifyFlow } from './transactions';
import type { AnalysisTransaction, FlowKind } from './transactions';

export type Cadence =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

type CadenceSpec = {
  cadence: Cadence;
  /** The usual number of days between charges. */
  days: number;
  /** Gaps between charges of this many days still count as this cadence. */
  minGap: number;
  maxGap: number;
  /** Months added to the last charge to predict the next, when it is a whole number. */
  months: number | null;
};

const DAYS_PER_MONTH = 30.4375;

const CADENCES: CadenceSpec[] = [
  { cadence: 'weekly', days: 7, minGap: 5, maxGap: 9, months: null },
  { cadence: 'biweekly', days: 14, minGap: 12, maxGap: 16, months: null },
  {
    cadence: 'monthly',
    days: DAYS_PER_MONTH,
    minGap: 26,
    maxGap: 35,
    months: 1,
  },
  { cadence: 'quarterly', days: 91.3125, minGap: 80, maxGap: 102, months: 3 },
  { cadence: 'yearly', days: 365.25, minGap: 340, maxGap: 390, months: 12 },
];

/** Share of the gaps between charges that must fit the cadence. */
export const MIN_REGULAR_GAP_SHARE = 0.75;
/** Charges that vary more than this (stdev over mean) are not "similar amounts". */
export const MAX_AMOUNT_VARIATION = 0.35;
/** Charges that vary less than this are a fixed price. */
export const FIXED_AMOUNT_VARIATION = 0.1;
/** Amounts within this of each other count as the same price. */
export const SAME_PRICE_TOLERANCE = 0.02;
/** A change in price of at least this much is reported. */
export const MIN_PRICE_CHANGE = 0.05;
/** A charge is "stopped" once this many cadences have passed without one. */
export const STOPPED_AFTER_CADENCES = 1.5;

export type RecurringCharge = {
  payee_id: string;
  payee: string;
  /** The category most of the charges were filed under. */
  category: string | null;
  direction: FlowKind;
  cadence: Cadence;
  /** The median charge, major units, signed like amounts. */
  typical_amount: number;
  amount_variability: 'fixed' | 'variable';
  occurrences: number;
  first_date: string;
  last_date: string;
  last_amount: number;
  next_expected_date: string;
  days_since_last: number;
  /** `stopped`: more than one and a half cadences have passed without a charge. */
  status: 'active' | 'stopped';
  /** Set when the price moved from one steady level to another. */
  price_change: {
    from: number;
    to: number;
    /** Positive when the charge got bigger. */
    percent_change: number;
    /** The first charge at the new price. */
    changed_on: string;
  } | null;
  /** The cost spread over a month and a year, major units, signed like amounts. */
  estimated_monthly_amount: number;
  estimated_yearly_amount: number;
  schedule: { id: string; name: string | null } | null;
};

export type RecurringReport = {
  charges: RecurringCharge[];
  /** Active charges only, per month, major units. */
  monthly_spending: number;
  monthly_income: number;
};

type RecurringOptions = {
  transactions: AnalysisTransaction[];
  today: string;
  /** Charges seen fewer times than this are not called recurring (yearly ones need two). */
  minOccurrences: number;
  /** Known schedules by the payee they pay. */
  schedulesByPayee: Map<string, { id: string; name: string | null }>;
  money: AmountConverter;
};

type Charge = { date: string; amount: number; category: string | null };

function cadenceFor(gaps: number[]): CadenceSpec | null {
  const typical = median(gaps);
  const spec = CADENCES.find(
    ({ minGap, maxGap }) => typical >= minGap && typical <= maxGap,
  );
  if (!spec) return null;

  const regular = gaps.filter(
    gap => gap >= spec.minGap && gap <= spec.maxGap,
  ).length;
  return regular / gaps.length >= MIN_REGULAR_GAP_SHARE ? spec : null;
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [value, count] of counts) {
    if (count > (counts.get(best ?? '') ?? 0)) best = value;
  }
  return best;
}

const withinTolerance = (a: number, b: number) =>
  Math.abs(a - b) <= SAME_PRICE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

// A price change is a steady price followed by a different steady price: at
// least two charges at the old price, then the latest charges all at the new.
function findPriceChange(sizes: number[], dates: string[]) {
  const last = sizes.length - 1;
  let start = last;
  while (start > 0 && withinTolerance(sizes[start - 1], sizes[last])) start--;
  const before = sizes.slice(Math.max(start - 6, 0), start);
  if (before.length < 2) return null;

  const old = median(before);
  if (!before.every(size => withinTolerance(size, old))) return null;
  if (Math.abs(sizes[last] - old) < MIN_PRICE_CHANGE * old) return null;
  return { from: old, to: sizes[last], changedOn: dates[start] };
}

export function detectRecurring({
  transactions,
  today,
  minOccurrences,
  schedulesByPayee,
  money,
}: RecurringOptions): RecurringReport {
  const payees = new Map<
    string,
    {
      payeeId: string;
      name: string;
      direction: FlowKind;
      charges: Map<string, Charge>;
    }
  >();
  for (const transaction of transactions) {
    const direction = classifyFlow(transaction);
    if (direction === null || transaction.payee_id === null) continue;

    const key = `${transaction.payee_id}|${direction}`;
    const entry = payees.get(key) ?? {
      payeeId: transaction.payee_id,
      name: transaction.payee ?? transaction.payee_id,
      direction,
      charges: new Map<string, Charge>(),
    };
    // Several charges on one day (a split payment) are one charge.
    const charge = entry.charges.get(transaction.date) ?? {
      date: transaction.date,
      amount: 0,
      category: transaction.category,
    };
    charge.amount += transaction.amount;
    entry.charges.set(transaction.date, charge);
    payees.set(key, entry);
  }

  const charges: RecurringCharge[] = [];
  for (const entry of payees.values()) {
    const list = [...entry.charges.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (list.length < 2) continue;

    const gaps = list
      .slice(1)
      .map((charge, index) => daysBetween(list[index].date, charge.date));
    const spec = cadenceFor(gaps);
    if (!spec) continue;
    if (list.length < (spec.cadence === 'yearly' ? 2 : minOccurrences)) {
      continue;
    }

    const sizes = list.map(charge => Math.abs(charge.amount));
    const average = mean(sizes);
    const variation = average === 0 ? 0 : stdev(sizes) / average;
    if (variation > MAX_AMOUNT_VARIATION) continue;

    const sign = entry.direction === 'spending' ? -1 : 1;
    const lastCharge = list[list.length - 1];
    const nextExpected =
      spec.months === null
        ? addDays(lastCharge.date, spec.days)
        : addMonthsToDay(lastCharge.date, spec.months);
    const daysSinceLast = daysBetween(lastCharge.date, today);
    const change = findPriceChange(
      sizes,
      list.map(charge => charge.date),
    );
    // After a price change, what the charge costs now is the new price.
    const typical = Math.round(change ? change.to : median(sizes));
    const perMonth = (typical * DAYS_PER_MONTH) / spec.days;
    const schedule = schedulesByPayee.get(entry.payeeId) ?? null;

    charges.push({
      payee_id: entry.payeeId,
      payee: entry.name,
      category: mostCommon(list.map(charge => charge.category)),
      direction: entry.direction,
      cadence: spec.cadence,
      typical_amount: money.toMajor(sign * typical),
      amount_variability:
        variation <= FIXED_AMOUNT_VARIATION ? 'fixed' : 'variable',
      occurrences: list.length,
      first_date: list[0].date,
      last_date: lastCharge.date,
      last_amount: money.toMajor(lastCharge.amount),
      next_expected_date: nextExpected,
      days_since_last: daysSinceLast,
      status:
        daysSinceLast > STOPPED_AFTER_CADENCES * spec.days
          ? 'stopped'
          : 'active',
      price_change: change
        ? {
            from: money.toMajor(sign * Math.round(change.from)),
            to: money.toMajor(sign * Math.round(change.to)),
            percent_change:
              Math.round((change.to / change.from - 1) * 1000) / 10,
            changed_on: change.changedOn,
          }
        : null,
      estimated_monthly_amount: money.toMajor(sign * roundMinor(perMonth)),
      estimated_yearly_amount: money.toMajor(sign * roundMinor(perMonth * 12)),
      schedule,
    });
  }

  charges.sort(
    (a, b) =>
      Number(a.status === 'stopped') - Number(b.status === 'stopped') ||
      Math.abs(b.estimated_yearly_amount) -
        Math.abs(a.estimated_yearly_amount) ||
      a.payee.localeCompare(b.payee),
  );

  const monthly = (direction: FlowKind) =>
    charges
      .filter(c => c.status === 'active' && c.direction === direction)
      .reduce(
        (total, c) => total + money.toMinor(c.estimated_monthly_amount),
        0,
      );
  return {
    charges,
    monthly_spending: money.toMajor(monthly('spending')),
    monthly_income: money.toMajor(monthly('income')),
  };
}
