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

/**
 * The net cash a vest event is worth: the recorded actual when there is one,
 * otherwise the estimate from the current price, or `null` without a price.
 */
export function vestEventNet(
  event: Pick<RsuVestEventEntity, 'shares' | 'actual_net'>,
  grant: Pick<RsuGrantEntity, 'withholding_rate'>,
  price: Pick<StockPriceEntity, 'price'> | null | undefined,
): number | null {
  if (event.actual_net != null) {
    return event.actual_net;
  }
  if (price == null) {
    return null;
  }
  return estimateVestNet({
    shares: event.shares,
    priceCents: price.price,
    withholdingRate: grant.withholding_rate,
  }).net;
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

export const RSU_SCHEDULE_PREFIX = 'RSU · ';

export function rsuScheduleName(
  grantName: string,
  vestDate: string,
  dupIndex = 0,
): string {
  const base = `${RSU_SCHEDULE_PREFIX}${grantName.trim()} · ${vestDate}`;
  return dupIndex > 0 ? `${base} (${dupIndex + 1})` : base;
}
