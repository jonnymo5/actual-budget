import { estimateVestNet, normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import { defineTool } from '#tools/registry';

const vestEventSchema = z.object({
  id: z.string(),
  vest_date: z.string().describe('YYYY-MM-DD.'),
  shares: z.number(),
  est_gross: z
    .number()
    .nullable()
    .describe('Shares × current price, major units; null without a price.'),
  est_net: z
    .number()
    .nullable()
    .describe(
      'Estimated cash after withholding, major units; null without a price.',
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
    'List RSU (restricted stock unit) grants with their vest rows and the share prices behind the estimates. Each vest row gives its date (YYYY-MM-DD), share count, and the estimated gross and net cash in major currency units (shares × price, net after the grant\'s tax withholding; shares are assumed sold at vest). Future vest rows also exist as one-off schedules named "RSU · <grant> · <date>", which is how they reach cash_flow_projection and the Balance Forecast.',
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
        unvested_est_net: z
          .number()
          .nullable()
          .describe(
            'Sum of est_net over vest rows on or after today, major units.',
          ),
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
      const rows = events
        .filter(event => event.grant_id === grant.id)
        .sort((a, b) => a.vest_date.localeCompare(b.vest_date))
        .map(event => {
          const estimate = price
            ? estimateVestNet({
                shares: event.shares,
                priceCents: price.price,
                withholdingRate: grant.withholding_rate,
              })
            : null;
          return {
            id: event.id,
            vest_date: event.vest_date,
            shares: event.shares,
            est_gross: estimate ? toMajor(estimate.gross) : null,
            est_net: estimate ? toMajor(estimate.net) : null,
            actual_net:
              event.actual_net == null ? null : toMajor(event.actual_net),
            schedule_id: event.schedule,
          };
        });
      const unvested = rows.filter(row => row.vest_date >= today);
      const unvestedNet = unvested.some(row => row.est_net == null)
        ? unvested.every(row => row.est_net == null)
          ? null
          : unvested.reduce((sum, row) => sum + (row.est_net ?? 0), 0)
        : unvested.reduce((sum, row) => sum + (row.est_net ?? 0), 0);
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
        unvested_est_net: unvested.length === 0 ? 0 : unvestedNet,
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
        `${grant.name} (${grant.ticker}): ${grant.total_shares} shares, ${Math.round(grant.withholding_rate * 100)}% withheld` +
          (grant.unvested_est_net == null
            ? ', no price yet'
            : `, ~${format(grant.unvested_est_net)} still to vest`) +
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
