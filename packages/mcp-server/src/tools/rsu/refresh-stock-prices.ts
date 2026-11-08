import { normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import { defineTool } from '#tools/registry';

export const refreshStockPrices = defineTool({
  name: 'refresh_stock_prices',
  title: 'Refresh stock prices',
  description:
    'Fetch the current share price for every ticker used by an RSU grant (or just the tickers given) through the sync server, and rewrite the estimated net of the matching vest schedules, and lock the vest-date closing price of any vest that has happened but has no price yet. Tickers whose price was set by hand are skipped unless force is true. Needs a sync server; without one the result says so and prices stay as they are.',
  kind: 'write',
  input: {
    tickers: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe('Only these symbols. Defaults to every ticker in use.'),
    force: z
      .boolean()
      .default(false)
      .describe('Also refresh tickers that have a manual price.'),
  },
  output: {
    tickers: z.array(z.string()).describe('The symbols that were considered.'),
    updated: z.array(z.string()),
    skipped: z
      .array(z.string())
      .describe('Left alone: manual price, invalid symbol, or no server.'),
    failed: z.array(z.object({ symbol: z.string(), reason: z.string() })),
    locked_vests: z
      .number()
      .describe('Past vest rows whose vest-date price was just locked.'),
    error: z
      .string()
      .nullable()
      .describe(
        '"no-server" when no sync server is configured, otherwise the failure reason; null on success.',
      ),
  },
  async handler({ tickers, force }, ctx) {
    const normalized = tickers?.map(normalizeTicker);

    if (ctx.dryRun) {
      const { grants, prices } = await ctx.lootCore.send('rsu/get');
      const wanted = normalized ?? [
        ...new Set(grants.map(grant => normalizeTicker(grant.ticker))),
      ];
      const skipped = wanted.filter(ticker => {
        const price = prices.find(p => normalizeTicker(p.id) === ticker);
        return !force && price?.manual_override;
      });
      const toFetch = wanted.filter(ticker => !skipped.includes(ticker));
      return {
        data: {
          tickers: wanted,
          updated: toFetch,
          skipped,
          failed: [],
          locked_vests: 0,
          error: null,
        },
        text:
          toFetch.length === 0
            ? 'Nothing to refresh.'
            : `Would fetch ${toFetch.join(', ')}` +
              (skipped.length > 0
                ? ` and leave ${skipped.join(', ')} (manual) alone`
                : '') +
              '.',
      };
    }

    const result = await ctx.lootCore.send('rsu/refresh-prices', {
      tickers: normalized,
      force,
    });
    const lock = result.error
      ? { locked: [], failed: [] }
      : await ctx.lootCore.send('rsu/lock-vest-prices', {});
    const considered = [...result.updated, ...result.skipped].concat(
      result.failed.map(item => item.symbol),
    );
    const parts = [];
    if (result.error === 'no-server') {
      parts.push(
        'No sync server is configured, so prices cannot be fetched. Set them by hand in the RSU Grants page.',
      );
    } else if (result.error) {
      parts.push(`Price refresh failed: ${result.error}.`);
    }
    if (result.updated.length > 0) {
      parts.push(`Updated ${result.updated.join(', ')}.`);
    }
    if (result.failed.length > 0) {
      parts.push(
        `No price for ${result.failed.map(item => `${item.symbol} (${item.reason})`).join(', ')}.`,
      );
    }
    if (result.skipped.length > 0 && !result.error) {
      parts.push(`Skipped ${result.skipped.join(', ')}.`);
    }
    if (lock.locked.length > 0) {
      parts.push(
        `Locked the vest-date price of ${lock.locked.length} past vests.`,
      );
    }
    return {
      data: {
        tickers: [...new Set(considered)],
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed,
        locked_vests: lock.locked.length,
        error: result.error ?? null,
      },
      text: parts.length > 0 ? parts.join(' ') : 'Nothing to refresh.',
    };
  },
});
