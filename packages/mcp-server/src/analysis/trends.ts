import type { AmountConverter } from '#actual/amounts';

import { addMonths, monthRange } from './dates';
import { compareTotals } from './spending';
import type { Comparison } from './spending';
import { fitLine, mean, roundMinor, roundTo, sum } from './statistics';
import { classifyFlow, groupOf } from './transactions';
import type { AnalysisTransaction, FlowKind, GroupBy } from './transactions';

/** A series must change by this share of its average over the window to count as a trend. */
export const TREND_MIN_CHANGE = 0.15;
/** ...and the straight line must explain at least this much of its ups and downs. */
export const TREND_MIN_R_SQUARED = 0.25;
/** Fewer months than this is not enough to call a direction. */
export const TREND_MIN_MONTHS = 3;

export type SeriesTrend = {
  /** `up`: the amounts are getting bigger (more spent, or more earned). */
  direction: 'up' | 'down' | 'flat';
  /** Straight-line change per month, major units, signed like amounts. */
  per_month: number;
  /** The same change as a percent of the average size; positive means growing. */
  percent_per_month: number | null;
  /** 0 to 1: how well a straight line fits the months. */
  r_squared: number;
};

export type TrendGroup = {
  key: string;
  name: string;
  /** Major units per month, in the order of `months`. */
  series: number[];
  total: number;
  average: number;
  trend: SeriesTrend;
  /** The last month against the one before it; null with no earlier data. */
  month_over_month: Comparison | null;
  /** The last month against the same month a year earlier; null with no data then. */
  year_over_year: Comparison | null;
};

export type SpendingTrends = {
  months: string[];
  overall: Omit<TrendGroup, 'key' | 'name'>;
  groups: TrendGroup[];
  /** Groups left out by the limit. */
  omitted_group_count: number;
};

type TrendOptions = {
  /** Transactions from 12 months before the first month to the end of the last. */
  transactions: AnalysisTransaction[];
  /** The months to show, oldest first. */
  months: string[];
  kind: FlowKind;
  groupBy: Exclude<GroupBy, 'month'>;
  limit: number;
  /** The month of the first transaction in the budget; earlier months have no data. */
  dataStartMonth: string | null;
  money: AmountConverter;
};

function classifyTrend(
  magnitudes: number[],
  sign: number,
  money: AmountConverter,
): SeriesTrend {
  const fit = fitLine(magnitudes);
  const average = mean(magnitudes);
  const window = fit.slope * (magnitudes.length - 1);
  const relative = average > 0 ? window / average : 0;
  const enough = magnitudes.length >= TREND_MIN_MONTHS;
  const trending = enough && fit.rSquared >= TREND_MIN_R_SQUARED;

  return {
    direction:
      trending && relative >= TREND_MIN_CHANGE
        ? 'up'
        : trending && relative <= -TREND_MIN_CHANGE
          ? 'down'
          : 'flat',
    per_month: money.toMajor(roundMinor(fit.slope * sign)),
    percent_per_month:
      average > 0 ? roundTo(fit.slope / average, 1, 100) : null,
    r_squared: roundTo(fit.rSquared, 2),
  };
}

function describeSeries(
  series: number[],
  months: string[],
  kind: FlowKind,
  dataStartMonth: string | null,
  money: AmountConverter,
): Omit<TrendGroup, 'key' | 'name'> {
  // `series` holds the 12 months before `months` first, so the last-year
  // comparison has something to compare with.
  const lead = series.length - months.length;
  const shown = series.slice(lead);
  const sign = kind === 'spending' ? -1 : 1;
  const last = shown.length - 1;

  const hasData = (month: string) =>
    dataStartMonth !== null && month >= dataStartMonth;
  const compare = (earlierMonth: string, earlier: number): Comparison | null =>
    hasData(earlierMonth)
      ? compareTotals(kind, shown[last], earlier, money)
      : null;

  return {
    series: shown.map(value => money.toMajor(value)),
    total: money.toMajor(sum(shown)),
    average: money.toMajor(roundMinor(mean(shown))),
    trend: classifyTrend(
      shown.map(value => value * sign),
      sign,
      money,
    ),
    month_over_month:
      last >= 1 ? compare(months[last - 1], shown[last - 1]) : null,
    year_over_year:
      lead >= 0 && series.length > months.length
        ? compare(addMonths(months[last], -12), series[lead + last - 12])
        : null,
  };
}

/** Months of history the year-over-year comparison needs before the first month shown. */
export const TREND_LEAD_MONTHS = 12;

export function analyzeTrends({
  transactions,
  months,
  kind,
  groupBy,
  limit,
  dataStartMonth,
  money,
}: TrendOptions): SpendingTrends {
  const allMonths = monthRange(
    addMonths(months[0], -TREND_LEAD_MONTHS),
    months[months.length - 1],
  );
  const indexOf = new Map(allMonths.map((month, index) => [month, index]));

  const groups = new Map<string, { name: string; series: number[] }>();
  const overall = allMonths.map(() => 0);
  for (const transaction of transactions) {
    if (classifyFlow(transaction) !== kind) continue;
    const index = indexOf.get(transaction.date.slice(0, 7));
    if (index === undefined) continue;

    const { key, name } = groupOf(transaction, groupBy);
    const group = groups.get(key) ?? { name, series: allMonths.map(() => 0) };
    group.series[index] += transaction.amount;
    groups.set(key, group);
    overall[index] += transaction.amount;
  }

  const described = [...groups.entries()].map(([key, group]) => ({
    key,
    name: group.name,
    ...describeSeries(group.series, months, kind, dataStartMonth, money),
  }));
  // The biggest movers first, whichever way they move; then the biggest spenders.
  described.sort(
    (a, b) =>
      Math.abs(b.trend.per_month) - Math.abs(a.trend.per_month) ||
      Math.abs(b.total) - Math.abs(a.total) ||
      a.name.localeCompare(b.name),
  );

  return {
    months,
    overall: describeSeries(overall, months, kind, dataStartMonth, money),
    groups: described.slice(0, limit),
    omitted_group_count: Math.max(described.length - limit, 0),
  };
}
