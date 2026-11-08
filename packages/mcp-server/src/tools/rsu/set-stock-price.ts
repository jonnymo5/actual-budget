import { normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import {
  buildPriceView,
  loadRsuData,
  priceByTicker,
  priceViewSchema,
  tickerSchema,
} from '#actual/rsu';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';

export const setStockPrice = defineTool({
  name: 'set_stock_price',
  title: 'Set a share price',
  description:
    'Set the share price used to estimate RSU vests for one ticker, in major currency units (e.g. dollars, not cents). A price set this way is marked manual and left alone by refresh_stock_prices until use_live is true, which drops the override and fetches the live quote again. Changing the price rewrites the estimated net of every open vest schedule in that ticker; rows that have vested keep their locked vest-date price.',
  kind: 'write',
  input: {
    ticker: tickerSchema,
    price: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'The share price, major units. Required unless use_live is true.',
      ),
    currency: z.string().trim().min(1).max(8).optional(),
    use_live: z
      .boolean()
      .default(false)
      .describe('Drop the manual price and fetch the live quote instead.'),
  },
  output: {
    ticker: z.string(),
    before: priceViewSchema.nullable(),
    after: priceViewSchema.nullable(),
    grants_affected: z.number(),
    error: z
      .string()
      .nullable()
      .describe(
        'Set when use_live could not fetch a quote (e.g. "no-server").',
      ),
  },
  async handler({ ticker, price, currency, use_live }, ctx) {
    if (price == null && !use_live) {
      throw toolError(
        'Give a price, or use_live true to go back to the live quote.',
      );
    }
    const data = await loadRsuData(ctx);
    const current = priceByTicker(data.prices).get(ticker) ?? null;
    const before = current ? buildPriceView(ctx, current) : null;
    const grantsAffected = data.grants.filter(
      grant => normalizeTicker(grant.ticker) === ticker,
    ).length;
    const { format, toMinor } = ctx.amounts;

    if (ctx.dryRun) {
      return {
        data: {
          ticker,
          before,
          after: null,
          grants_affected: grantsAffected,
          error: null,
        },
        text: use_live
          ? `Would drop the manual price for ${ticker}${before ? ` (now ${format(before.price)})` : ''} and fetch the live quote, re-estimating ${grantsAffected} grants.`
          : `Would set ${ticker} to ${format(price ?? 0)}${before ? ` (now ${format(before.price)}${before.manual_override ? ', manual' : ''})` : ''}, re-estimating ${grantsAffected} grants.`,
      };
    }

    let error: string | null = null;
    if (use_live) {
      await ctx.lootCore.send('rsu/set-price', {
        ticker,
        manual_override: false,
      });
      const refresh = await ctx.lootCore.send('rsu/refresh-prices', {
        tickers: [ticker],
        force: true,
      });
      if (refresh.error) {
        error = refresh.error;
      } else if (!refresh.updated.includes(ticker)) {
        error =
          refresh.failed.find(f => f.symbol === ticker)?.reason ?? 'not-found';
      }
    } else {
      await ctx.lootCore.send('rsu/set-price', {
        ticker,
        price: toMinor(price ?? 0),
        ...(currency ? { currency } : {}),
        manual_override: true,
      });
    }

    const afterData = await loadRsuData(ctx);
    const afterPrice = priceByTicker(afterData.prices).get(ticker) ?? null;
    const after = afterPrice ? buildPriceView(ctx, afterPrice) : null;
    const text = error
      ? `Dropped the manual price for ${ticker}, but no live quote could be fetched (${error}); ${after ? `the last price ${format(after.price)} stays` : 'there is no price'}.`
      : `${ticker} is now ${after ? format(after.price) : 'unset'}${use_live ? ' (live)' : ' (manual)'}; ${grantsAffected} grants re-estimated.`;
    return {
      data: { ticker, before, after, grants_affected: grantsAffected, error },
      text,
    };
  },
});
