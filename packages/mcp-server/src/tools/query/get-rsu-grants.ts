import {
  normalizeTicker,
  summarizeGrantPayout,
  vestEventValue,
} from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import { defineTool } from '#tools/registry';

const vestEventSchema = z.object({
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

export const getRsuGrants = defineTool({
  name: 'get_rsu_grants',
  title: 'List RSU grants',
  description:
    'List RSU (restricted stock unit) grants with their vest rows and the share prices behind the estimates. Each vest row gives its date (YYYY-MM-DD), share count, and the gross and net cash in major currency units (shares × price, net after the grant\'s tax withholding; shares are assumed sold at vest). Rows that have vested use the share price locked on the vest date, or the deposit the user recorded, so a grant\'s paid-out total does not move with the market. Future vest rows also exist as one-off schedules named "RSU · <grant> · <date>", which is how they reach cash_flow_projection and the Balance Forecast.',
  kind: 'read',
  input: {},
  output: {
    grants: z.array(
      z.object({
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
        vest_events: z.array(vestEventSchema),
      }),
    ),
    prices: z.array(
      z.object({
        ticker: z.string(),
        price: z.number().describe('Major units per share.'),
        currency: z.string().nullable(),
        as_of: z.string().nullable().describe('ISO timestamp of the quote.'),
        source: z.enum(['yahoo', 'stooq', 'manual']).nullable(),
        manual_override: z
          .boolean()
          .describe('True when automatic refreshes leave this price alone.'),
      }),
    ),
  },
  async handler(_input, ctx) {
    const { grants, events, prices } = await ctx.lootCore.send('rsu/get');
    const { toMajor, format } = ctx.amounts;
    const today = ctx.today();
    const priceByTicker = new Map(
      prices.map(price => [normalizeTicker(price.id), price] as const),
    );

    const grantRows = grants.map(grant => {
      const price = priceByTicker.get(normalizeTicker(grant.ticker)) ?? null;
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
          actual_net:
            event.actual_net == null ? null : toMajor(event.actual_net),
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
    });

    const priceRows = prices.map(price => ({
      ticker: normalizeTicker(price.id),
      price: toMajor(price.price),
      currency: price.currency,
      as_of: price.as_of,
      source: price.source,
      manual_override: price.manual_override,
    }));

    const lines: string[] = [];
    for (const grant of grantRows) {
      lines.push(
        `${grant.name} (${grant.ticker}): ${grant.total_shares} shares, ${Math.round(grant.withholding_rate * 100)}% withheld, ${format(grant.paid_out_net)} paid out, ~${format(grant.remaining_est_net)} still to vest` +
          (grant.unvalued_rows > 0
            ? ` (${grant.unvalued_rows} rows without a price)`
            : '') +
          ` [id: ${grant.id}]`,
      );
      for (const row of grant.vest_events) {
        if (row.vest_date < today) continue;
        lines.push(
          `  ${row.vest_date}: ${row.shares} shares` +
            (row.est_net == null ? '' : ` → ~${format(row.est_net)} net`),
        );
      }
    }
    for (const price of priceRows) {
      lines.push(
        `${price.ticker} ${format(price.price)}${price.currency ? ` ${price.currency}` : ''}` +
          (price.manual_override ? ' (manual)' : '') +
          (price.as_of ? ` as of ${price.as_of}` : ''),
      );
    }

    return {
      data: { grants: grantRows, prices: priceRows },
      text: lines.length > 0 ? lines.join('\n') : 'No RSU grants.',
    };
  },
});
