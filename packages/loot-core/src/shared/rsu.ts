import { addMonths, format, parseISO } from 'date-fns';

import type {
  RsuCadenceInput,
  RsuGrantEntity,
  RsuVestEventEntity,
  RsuVestFrequency,
  RsuVestRow,
  StockPriceEntity,
} from '#types/models';

export const RSU_FREQUENCY_MONTHS: Record<RsuVestFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export const RSU_FREQUENCIES = Object.keys(
  RSU_FREQUENCY_MONTHS,
) as RsuVestFrequency[];

/** Share counts are kept to six decimal places so rows sum exactly. */
const SHARE_SCALE = 1_000_000;

export const TICKER_RE = /^[A-Z0-9.\-^=]{1,12}$/;

export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function isValidTicker(ticker: string): boolean {
  return TICKER_RE.test(ticker);
}

export function roundShares(shares: number): number {
  return Math.round(shares * SHARE_SCALE) / SHARE_SCALE;
}

function addMonthsIso(anchorIso: string, months: number): string {
  return format(addMonths(parseISO(anchorIso), months), 'yyyy-MM-dd');
}

/**
 * Expand a vesting cadence into dated rows whose share counts sum exactly to
 * `totalShares`. Without a cliff the rows fall on `vestStart + k * step` for
 * k = 0..periods-1. With a cliff, one row vests `cliffPercent` of the grant
 * `cliffMonths` after `vestStart`, and `periods` further rows follow every
 * `step` months after the cliff. Any rounding remainder lands on the last row.
 */
export function generateVestEvents(input: RsuCadenceInput): RsuVestRow[] {
  const step = RSU_FREQUENCY_MONTHS[input.frequency];
  const periods = Math.max(0, Math.floor(input.periods));
  const totalUnits = Math.round(input.totalShares * SHARE_SCALE);
  const cliffPercent = input.cliffPercent ?? 0;
  const hasCliff = cliffPercent > 0;
  const cliffMonths = hasCliff ? Math.max(0, input.cliffMonths ?? 0) : 0;

  if (!(totalUnits > 0) || (periods === 0 && !hasCliff)) {
    return [];
  }

  const rows: Array<{ vest_date: string; units: number }> = [];

  const cliffUnits = hasCliff
    ? Math.min(totalUnits, Math.round((totalUnits * cliffPercent) / 100))
    : 0;
  if (hasCliff) {
    rows.push({
      vest_date: addMonthsIso(input.vestStart, cliffMonths),
      units: cliffUnits,
    });
  }

  const remaining = totalUnits - cliffUnits;
  if (periods > 0) {
    const perPeriod = Math.floor(remaining / periods);
    for (let k = 0; k < periods; k++) {
      const offset = hasCliff ? cliffMonths + (k + 1) * step : k * step;
      rows.push({
        vest_date: addMonthsIso(input.vestStart, offset),
        units: perPeriod,
      });
    }
    rows[rows.length - 1].units += remaining - perPeriod * periods;
  } else {
    rows[rows.length - 1].units += remaining;
  }

  return rows
    .filter(row => row.units > 0)
    .map(row => ({
      vest_date: row.vest_date,
      shares: row.units / SHARE_SCALE,
    }));
}

export function sumShares(rows: ReadonlyArray<{ shares: number }>): number {
  const units = rows.reduce(
    (total, row) => total + Math.round(row.shares * SHARE_SCALE),
    0,
  );
  return units / SHARE_SCALE;
}

export function clampWithholdingRate(rate: number | null | undefined): number {
  if (rate == null || Number.isNaN(rate)) {
    return 0;
  }
  return Math.min(Math.max(rate, 0), 1);
}

/**
 * Estimated cash from selling `shares` at `priceCents` after withholding.
 * Both results are integer cents.
 */
export function estimateVestNet({
  shares,
  priceCents,
  withholdingRate,
}: {
  shares: number;
  priceCents: number;
  withholdingRate: number | null | undefined;
}): { gross: number; net: number } {
  const gross = Math.round(shares * priceCents);
  const rate = clampWithholdingRate(withholdingRate);
  const net = Math.round(shares * priceCents * (1 - rate));
  return { gross, net };
}

export type VestValueBasis = 'actual' | 'locked' | 'current';

export type VestValue = {
  gross: number;
  net: number;
  /** actual: recorded net; locked: price on the vest date; current: latest quote */
  basis: VestValueBasis;
};

/**
 * What a vest event is worth, from the most to the least certain source: the
 * net the user recorded, then the share price locked on the vest date, then
 * the current quote. `null` when there is nothing to go on.
 */
export function vestEventValue(
  event: Pick<RsuVestEventEntity, 'shares' | 'actual_net' | 'actual_price'>,
  grant: Pick<RsuGrantEntity, 'withholding_rate'>,
  price: Pick<StockPriceEntity, 'price'> | null | undefined,
): VestValue | null {
  if (event.actual_net != null) {
    const gross =
      event.actual_price != null
        ? Math.round(event.shares * event.actual_price)
        : event.actual_net;
    return { gross, net: event.actual_net, basis: 'actual' };
  }
  if (event.actual_price != null) {
    return {
      ...estimateVestNet({
        shares: event.shares,
        priceCents: event.actual_price,
        withholdingRate: grant.withholding_rate,
      }),
      basis: 'locked',
    };
  }
  if (price == null) {
    return null;
  }
  return {
    ...estimateVestNet({
      shares: event.shares,
      priceCents: price.price,
      withholdingRate: grant.withholding_rate,
    }),
    basis: 'current',
  };
}

/** The net cash a vest event is worth; see `vestEventValue`. */
export function vestEventNet(
  event: Pick<RsuVestEventEntity, 'shares' | 'actual_net' | 'actual_price'>,
  grant: Pick<RsuGrantEntity, 'withholding_rate'>,
  price: Pick<StockPriceEntity, 'price'> | null | undefined,
): number | null {
  return vestEventValue(event, grant, price)?.net ?? null;
}

export type GrantPayout = {
  /** Net of rows that have vested (before today), cents */
  paidOut: number;
  /** Net of rows still to vest at the current price, cents */
  remaining: number;
  /** Rows that could not be valued at all */
  unvaluedCount: number;
  vestedShares: number;
  unvestedShares: number;
};

export function summarizeGrantPayout(
  grant: Pick<RsuGrantEntity, 'withholding_rate'>,
  events: ReadonlyArray<
    Pick<
      RsuVestEventEntity,
      'shares' | 'actual_net' | 'actual_price' | 'vest_date'
    >
  >,
  price: Pick<StockPriceEntity, 'price'> | null | undefined,
  today: string,
): GrantPayout {
  const summary: GrantPayout = {
    paidOut: 0,
    remaining: 0,
    unvaluedCount: 0,
    vestedShares: 0,
    unvestedShares: 0,
  };
  for (const event of events) {
    const vested = event.vest_date < today;
    const value = vestEventValue(event, grant, price);
    if (vested) {
      summary.vestedShares += event.shares;
    } else {
      summary.unvestedShares += event.shares;
    }
    if (value == null) {
      summary.unvaluedCount += 1;
    } else if (vested) {
      summary.paidOut += value.net;
    } else {
      summary.remaining += value.net;
    }
  }
  summary.vestedShares = roundShares(summary.vestedShares);
  summary.unvestedShares = roundShares(summary.unvestedShares);
  return summary;
}

export type RsuProjectionRow = {
  grantId: RsuGrantEntity['id'];
  /** Net cents per calendar month, index 0 = January. */
  months: number[];
  total: number;
  /** Months (0-based) with at least one recorded actual amount. */
  recordedMonths: number[];
};

export type RsuProjection = {
  rows: RsuProjectionRow[];
  totals: number[];
  grandTotal: number;
  /** Tickers of grants that have events in this year but no price. */
  missingPriceTickers: string[];
};

export function projectRsuIncomeByMonth({
  grants,
  events,
  prices,
  year,
}: {
  grants: ReadonlyArray<RsuGrantEntity>;
  events: ReadonlyArray<RsuVestEventEntity>;
  prices: ReadonlyArray<StockPriceEntity>;
  year: number;
}): RsuProjection {
  const priceByTicker = new Map(prices.map(price => [price.id, price]));
  const totals = Array<number>(12).fill(0);
  const missing = new Set<string>();
  const prefix = `${year}-`;

  const rows = grants.map(grant => {
    const months = Array<number>(12).fill(0);
    const recorded = new Set<number>();
    const price = priceByTicker.get(normalizeTicker(grant.ticker));

    for (const event of events) {
      if (event.grant_id !== grant.id || !event.vest_date.startsWith(prefix)) {
        continue;
      }
      const monthIndex = Number(event.vest_date.slice(5, 7)) - 1;
      if (monthIndex < 0 || monthIndex > 11) {
        continue;
      }
      const net = vestEventNet(event, grant, price);
      if (net == null) {
        missing.add(normalizeTicker(grant.ticker));
        continue;
      }
      months[monthIndex] += net;
      totals[monthIndex] += net;
      if (event.actual_net != null) {
        recorded.add(monthIndex);
      }
    }

    return {
      grantId: grant.id,
      months,
      total: months.reduce((sum, amount) => sum + amount, 0),
      recordedMonths: [...recorded].sort((a, b) => a - b),
    };
  });

  return {
    rows,
    totals,
    grandTotal: totals.reduce((sum, amount) => sum + amount, 0),
    missingPriceTickers: [...missing].sort(),
  };
}

export type RsuBudgetAmount = {
  category: string;
  /** YYYY-MM */
  month: string;
  /** Net cents of every vest in the month, summed across grants */
  amount: number;
};

export type RsuBudgetPlan = {
  amounts: RsuBudgetAmount[];
  /** Months left out because a vest in them has no price to value it with. */
  unpriced: Array<{ category: string; month: string; ticker: string }>;
};

/**
 * What to budget in each income category that RSU deposits land in: for every
 * month given, the summed net of all vests dated in that month across every
 * grant in the category, or 0 when nothing vests. A month with a vest that
 * cannot be valued is left out of `amounts` so its budget is not overwritten
 * with a figure that is too low.
 */
export function planRsuBudget({
  grants,
  events,
  prices,
  months,
}: {
  grants: ReadonlyArray<
    Pick<RsuGrantEntity, 'id' | 'ticker' | 'category' | 'withholding_rate'>
  >;
  events: ReadonlyArray<
    Pick<
      RsuVestEventEntity,
      'grant_id' | 'vest_date' | 'shares' | 'actual_net' | 'actual_price'
    >
  >;
  prices: ReadonlyArray<Pick<StockPriceEntity, 'id' | 'price'>>;
  /** YYYY-MM months to plan */
  months: ReadonlyArray<string>;
}): RsuBudgetPlan {
  const priceByTicker = new Map(prices.map(price => [price.id, price]));
  const wanted = new Set(months);
  const totals = new Map<string, Map<string, number>>();
  const unpriced = new Map<string, { month: string; ticker: string }>();

  for (const grant of grants) {
    if (!grant.category) {
      continue;
    }
    const category = grant.category;
    const byMonth = totals.get(category) ?? new Map<string, number>();
    totals.set(category, byMonth);
    const ticker = normalizeTicker(grant.ticker);
    const price = priceByTicker.get(ticker);

    for (const event of events) {
      const month = event.vest_date.slice(0, 7);
      if (event.grant_id !== grant.id || !wanted.has(month)) {
        continue;
      }
      const net = vestEventNet(event, grant, price);
      if (net == null) {
        unpriced.set(`${category}|${month}`, { month, ticker });
        continue;
      }
      byMonth.set(month, (byMonth.get(month) ?? 0) + net);
    }
  }

  const amounts: RsuBudgetAmount[] = [];
  for (const [category, byMonth] of totals) {
    for (const month of months) {
      if (!unpriced.has(`${category}|${month}`)) {
        amounts.push({ category, month, amount: byMonth.get(month) ?? 0 });
      }
    }
  }
  return {
    amounts,
    unpriced: [...unpriced].map(([key, value]) => ({
      category: key.slice(0, key.indexOf('|')),
      ...value,
    })),
  };
}

export const RSU_SCHEDULE_PREFIX = 'RSU · ';

export function rsuScheduleName(
  grantName: string,
  vestDate: string,
  dupIndex = 0,
): string {
  const base = `${RSU_SCHEDULE_PREFIX}${grantName.trim()} · ${vestDate}`;
  return dupIndex > 0 ? `${base} (${dupIndex + 1})` : base;
}

/** How long after a vest its deposit is still accepted as a match. */
export const DEPOSIT_WINDOW_AFTER_DAYS = 10;
/** How long before a vest a deposit may land and still count. */
export const DEPOSIT_WINDOW_BEFORE_DAYS = 2;

export type DepositCandidate = {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Integer cents, positive */
  amount: number;
};

export type DepositMatch = {
  eventId: string;
  vestDate: string;
  transactionId: string;
  depositDate: string;
  amount: number;
};

export type DepositMatchPlan = {
  matched: DepositMatch[];
  unmatched: string[];
};

function dayDistance(a: string, b: string): number {
  return (
    (new Date(`${a}T00:00:00Z`).getTime() -
      new Date(`${b}T00:00:00Z`).getTime()) /
    86_400_000
  );
}

/**
 * Pair vest events with deposits: each event takes the unused deposit that
 * landed closest to its vest date, within the window. Pure, so the same plan
 * can be previewed and then applied.
 */
export function planDepositMatches(
  events: ReadonlyArray<Pick<RsuVestEventEntity, 'id' | 'vest_date'>>,
  deposits: ReadonlyArray<DepositCandidate>,
): DepositMatchPlan {
  const plan: DepositMatchPlan = { matched: [], unmatched: [] };
  const used = new Set<string>();
  const ordered = [...events].sort((a, b) =>
    a.vest_date.localeCompare(b.vest_date),
  );

  for (const event of ordered) {
    const candidates = deposits
      .filter(deposit => {
        if (used.has(deposit.id) || deposit.amount <= 0) {
          return false;
        }
        const offset = dayDistance(deposit.date, event.vest_date);
        return (
          offset >= -DEPOSIT_WINDOW_BEFORE_DAYS &&
          offset <= DEPOSIT_WINDOW_AFTER_DAYS
        );
      })
      .sort(
        (a, b) =>
          Math.abs(dayDistance(a.date, event.vest_date)) -
          Math.abs(dayDistance(b.date, event.vest_date)),
      );
    const deposit = candidates[0];
    if (!deposit) {
      plan.unmatched.push(event.id);
      continue;
    }
    used.add(deposit.id);
    plan.matched.push({
      eventId: event.id,
      vestDate: event.vest_date,
      transactionId: deposit.id,
      depositDate: deposit.date,
      amount: deposit.amount,
    });
  }
  return plan;
}
