import {
  normalizeTicker,
  projectRsuIncomeByMonth,
  summarizeGrantPayout,
  vestEventValue,
} from '@actual-app/core/shared/rsu';
import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '@actual-app/core/types/models';
import { z } from 'zod';

import { toolError } from '#errors';
import { isoDate } from '#tools/schemas';

import type { ActualContext } from './session';

export type RsuData = {
  grants: RsuGrantEntity[];
  events: RsuVestEventEntity[];
  prices: StockPriceEntity[];
};

export function loadRsuData(ctx: ActualContext): Promise<RsuData> {
  return ctx.lootCore.send('rsu/get');
}

/** A grant from its id or exact name (case-insensitive). */
export function resolveGrant(
  grants: ReadonlyArray<RsuGrantEntity>,
  text: string,
): RsuGrantEntity {
  const trimmed = text.trim();
  const byId = grants.find(grant => grant.id === trimmed);
  if (byId) return byId;
  const wanted = trimmed.toLowerCase();
  const matches = grants.filter(grant => grant.name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw toolError(
      `RSU grant name "${text}" is ambiguous. Use the id of the one you mean: ${matches.map(g => `${g.name} (${g.id})`).join(', ')}.`,
    );
  }
  const names = grants.map(grant => grant.name).join(', ');
  throw toolError(
    `unknown RSU grant "${text}".${names ? ` Available: ${names}.` : ' There are no grants yet; create_rsu_grant adds one.'} get_rsu_grants lists them with their ids.`,
  );
}

/** Tickers are upper-case symbols such as ACME or BRK.B. */
export const tickerSchema = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .transform(normalizeTicker)
  .refine(value => /^[A-Z0-9.\-^=]{1,12}$/.test(value), {
    error: 'must be a stock symbol such as ACME or BRK.B',
  });

export const withholdingPercentSchema = z
  .number()
  .min(0)
  .max(99)
  .describe(
    'Percent of each vest withheld for tax, 0 to 99 (e.g. 37 for 37%). Check a vest statement for the right figure.',
  );

export const vestRowInputSchema = z.object({
  date: isoDate.describe('YYYY-MM-DD, the vest date.'),
  shares: z.number().positive().describe('Shares vesting on that date.'),
  vest_price: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Share price on the vest date, major units. Usually left out: it is looked up and locked once the date has passed.',
    ),
  actual_net: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'The deposit that actually arrived for this vest, major units. Leave out for rows that have not vested.',
    ),
});
export type VestRowInput = z.output<typeof vestRowInputSchema>;

export const cadenceInputSchema = z.object({
  vest_start: isoDate.describe(
    'YYYY-MM-DD. The first vest date, or the start of the vesting period when there is a cliff.',
  ),
  frequency: z
    .enum(['monthly', 'quarterly', 'semiannual', 'annual'])
    .describe('How often the regular vests happen.'),
  periods: z
    .number()
    .int()
    .min(0)
    .max(600)
    .describe(
      'Number of regular vests (after the cliff, when there is one). 16 for four years of quarterly vests.',
    ),
  cliff_percent: z
    .number()
    .min(0)
    .max(100)
    .default(0)
    .describe('Share of the grant that vests at the cliff; 0 for no cliff.'),
  cliff_months: z
    .number()
    .int()
    .min(0)
    .default(12)
    .describe('Months after vest_start at which the cliff vests.'),
});

export const vestEventViewSchema = z.object({
  id: z.string(),
  vest_date: z.string().describe('YYYY-MM-DD.'),
  shares: z.number(),
  vest_price: z
    .number()
    .nullable()
    .describe(
      'Share price locked on the vest date, major units; set once a row has vested.',
    ),
  est_gross: z
    .number()
    .nullable()
    .describe(
      'Shares × price, major units: the vest-date price once locked, else the current quote; null without either.',
    ),
  est_net: z
    .number()
    .nullable()
    .describe(
      'Cash after withholding, major units; the recorded actual net when there is one.',
    ),
  basis: z
    .enum(['actual', 'locked', 'current'])
    .nullable()
    .describe(
      'Where est_net comes from: a recorded deposit, the locked vest-date price, or the current quote.',
    ),
  actual_net: z
    .number()
    .nullable()
    .describe('Net the user recorded after the vest, major units.'),
  schedule_id: z
    .string()
    .nullable()
    .describe('The schedule that stands for this vest, once created.'),
});

export const grantViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  ticker: z.string(),
  grant_date: z.string().nullable().describe('YYYY-MM-DD.'),
  total_shares: z.number(),
  account_id: z.string(),
  payee_id: z.string(),
  category_id: z.string().nullable(),
  withholding_rate: z
    .number()
    .describe('Fraction withheld for tax, 0..1 (0.37 = 37%).'),
  paid_out_net: z
    .number()
    .describe(
      'Net of rows that have vested (recorded deposits, else vest-date price estimates), major units.',
    ),
  remaining_est_net: z
    .number()
    .describe(
      'Estimated net of rows still to vest at the current quote, major units.',
    ),
  unvalued_rows: z
    .number()
    .describe('Rows with neither a recorded net nor any price.'),
  vest_events: z.array(vestEventViewSchema),
});
export type GrantView = z.output<typeof grantViewSchema>;

export const priceViewSchema = z.object({
  ticker: z.string(),
  price: z.number().describe('Major units per share.'),
  currency: z.string().nullable(),
  as_of: z.string().nullable().describe('ISO timestamp of the quote.'),
  source: z.enum(['yahoo', 'stooq', 'manual']).nullable(),
  manual_override: z
    .boolean()
    .describe('True when automatic refreshes leave this price alone.'),
});
export type PriceView = z.output<typeof priceViewSchema>;

export function priceByTicker(prices: ReadonlyArray<StockPriceEntity>) {
  return new Map(
    prices.map(price => [normalizeTicker(price.id), price] as const),
  );
}

export function buildGrantView(
  ctx: ActualContext,
  grant: RsuGrantEntity,
  events: ReadonlyArray<RsuVestEventEntity>,
  price: StockPriceEntity | null,
): GrantView {
  const { toMajor } = ctx.amounts;
  const today = ctx.today();
  const grantEvents = events
    .filter(event => event.grant_id === grant.id)
    .sort((a, b) => a.vest_date.localeCompare(b.vest_date));
  const rows = grantEvents.map(event => {
    const value = vestEventValue(event, grant, price);
    return {
      id: event.id,
      vest_date: event.vest_date,
      shares: event.shares,
      vest_price:
        event.actual_price == null ? null : toMajor(event.actual_price),
      est_gross: value ? toMajor(value.gross) : null,
      est_net: value ? toMajor(value.net) : null,
      basis: value?.basis ?? null,
      actual_net: event.actual_net == null ? null : toMajor(event.actual_net),
      schedule_id: event.schedule,
    };
  });
  const payout = summarizeGrantPayout(grant, grantEvents, price, today);
  return {
    id: grant.id,
    name: grant.name,
    ticker: normalizeTicker(grant.ticker),
    grant_date: grant.grant_date,
    total_shares: grant.total_shares,
    account_id: grant.account,
    payee_id: grant.payee,
    category_id: grant.category,
    withholding_rate: grant.withholding_rate,
    paid_out_net: toMajor(payout.paidOut),
    remaining_est_net: toMajor(payout.remaining),
    unvalued_rows: payout.unvaluedCount,
    vest_events: rows,
  };
}

export function buildPriceView(
  ctx: ActualContext,
  price: StockPriceEntity,
): PriceView {
  return {
    ticker: normalizeTicker(price.id),
    price: ctx.amounts.toMajor(price.price),
    currency: price.currency,
    as_of: price.as_of,
    source: price.source,
    manual_override: price.manual_override,
  };
}

export function describeGrant(
  ctx: ActualContext,
  grant: GrantView,
  { upcomingOnly = true }: { upcomingOnly?: boolean } = {},
): string[] {
  const { format } = ctx.amounts;
  const today = ctx.today();
  const lines = [
    `${grant.name} (${grant.ticker}): ${grant.total_shares} shares, ${Math.round(grant.withholding_rate * 100)}% withheld, ${format(grant.paid_out_net)} paid out, ~${format(grant.remaining_est_net)} still to vest` +
      (grant.unvalued_rows > 0
        ? ` (${grant.unvalued_rows} rows without a price)`
        : '') +
      ` [id: ${grant.id}]`,
  ];
  for (const row of grant.vest_events) {
    if (upcomingOnly && row.vest_date < today) continue;
    lines.push(
      `  ${row.vest_date}: ${row.shares} shares` +
        (row.est_net == null
          ? ''
          : ` → ${row.basis === 'current' ? '~' : ''}${format(row.est_net)} net` +
            (row.basis === 'actual'
              ? ' (recorded)'
              : row.basis === 'locked'
                ? ` at ${format(row.vest_price ?? 0)}`
                : '')),
    );
  }
  return lines;
}

/** Net per month for a year, major units, from the same logic as the UI grid. */
export function monthlyIncome(
  ctx: ActualContext,
  data: RsuData,
  grants: ReadonlyArray<RsuGrantEntity>,
  year: number,
) {
  const projection = projectRsuIncomeByMonth({
    grants,
    events: data.events,
    prices: data.prices,
    year,
  });
  const { toMajor } = ctx.amounts;
  return {
    year,
    grants: projection.rows.map(row => ({
      grant_id: row.grantId,
      months: row.months.map(toMajor),
      total: toMajor(row.total),
    })),
    totals: projection.totals.map(toMajor),
    grand_total: toMajor(projection.grandTotal),
    missing_price_tickers: projection.missingPriceTickers,
  };
}
