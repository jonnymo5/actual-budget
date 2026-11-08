import { normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import {
  buildGrantView,
  buildPriceView,
  describeGrant,
  grantViewSchema,
  loadRsuData,
  monthlyIncome,
  priceByTicker,
  priceViewSchema,
  resolveGrant,
} from '#actual/rsu';
import { defineTool } from '#tools/registry';

export const getRsuGrants = defineTool({
  name: 'get_rsu_grants',
  title: 'List RSU grants',
  description:
    'List RSU (restricted stock unit) grants with their vest rows and the share prices behind the estimates. Each vest row gives its date (YYYY-MM-DD), share count, and the gross and net cash in major currency units (shares × price, net after the grant\'s tax withholding; shares are assumed sold at vest). Rows that have vested use the share price locked on the vest date, or the deposit the user recorded, so a grant\'s paid-out total does not move with the market. Future vest rows also exist as one-off schedules named "RSU · <grant> · <date>", which is how they reach cash_flow_projection and the Balance Forecast. Pass year to also get the net per calendar month for that year.',
  kind: 'read',
  input: {
    grant: z
      .string()
      .min(1)
      .optional()
      .describe('Only this grant (name or id).'),
    ticker: z
      .string()
      .min(1)
      .optional()
      .describe('Only grants in this stock symbol.'),
    year: z
      .number()
      .int()
      .min(1990)
      .max(2200)
      .optional()
      .describe(
        'Also return the net per month of this calendar year (what the RSU Grants page shows in its grid).',
      ),
    include_past_rows: z
      .boolean()
      .default(true)
      .describe('Include vest rows whose date has passed. Default true.'),
  },
  output: {
    grants: z.array(grantViewSchema),
    prices: z.array(priceViewSchema),
    monthly: z
      .object({
        year: z.number(),
        grants: z.array(
          z.object({
            grant_id: z.string(),
            months: z
              .array(z.number())
              .describe('Twelve amounts, January first, major units.'),
            total: z.number(),
          }),
        ),
        totals: z.array(z.number()).describe('Twelve amounts, all grants.'),
        grand_total: z.number(),
        missing_price_tickers: z
          .array(z.string())
          .describe('Tickers whose rows were left out for want of a price.'),
      })
      .nullable()
      .describe('Only when year was given.'),
  },
  async handler({ grant, ticker, year, include_past_rows }, ctx) {
    const data = await loadRsuData(ctx);
    const prices = priceByTicker(data.prices);
    const today = ctx.today();

    let grants = data.grants;
    if (grant) {
      grants = [resolveGrant(data.grants, grant)];
    }
    if (ticker) {
      const wanted = normalizeTicker(ticker);
      grants = grants.filter(g => normalizeTicker(g.ticker) === wanted);
    }

    const grantRows = grants.map(g => {
      const view = buildGrantView(
        ctx,
        g,
        data.events,
        prices.get(normalizeTicker(g.ticker)) ?? null,
      );
      return include_past_rows
        ? view
        : {
            ...view,
            vest_events: view.vest_events.filter(row => row.vest_date >= today),
          };
    });
    const tickers = new Set(grantRows.map(g => g.ticker));
    const priceRows = data.prices
      .filter(
        price => tickers.size === 0 || tickers.has(normalizeTicker(price.id)),
      )
      .map(price => buildPriceView(ctx, price));
    const monthly =
      year == null ? null : monthlyIncome(ctx, data, grants, year);

    const { format } = ctx.amounts;
    const lines: string[] = [];
    for (const row of grantRows) {
      lines.push(...describeGrant(ctx, row, { upcomingOnly: true }));
    }
    for (const price of priceRows) {
      lines.push(
        `${price.ticker} ${format(price.price)}${price.currency ? ` ${price.currency}` : ''}` +
          (price.manual_override ? ' (manual)' : '') +
          (price.as_of ? ` as of ${price.as_of}` : ''),
      );
    }
    if (monthly) {
      lines.push(
        `${monthly.year} net by month: ${monthly.totals.map(format).join(', ')} (total ${format(monthly.grand_total)})`,
      );
    }

    return {
      data: { grants: grantRows, prices: priceRows, monthly },
      text: lines.length > 0 ? lines.join('\n') : 'No RSU grants.',
    };
  },
});
