import { normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import { loadRsuData, resolveGrant } from '#actual/rsu';
import { defineTool } from '#tools/registry';

export const lockRsuVestPrices = defineTool({
  name: 'lock_rsu_vest_prices',
  title: 'Lock vest-date prices',
  description:
    "Look up the closing share price on the vest date of every RSU vest that has already happened but has no vest price yet, and lock it on the row, so the row's value stops following the current quote. Uses the last trading day before the date when the market was shut. Needs a sync server; without one, set vest_price through update_rsu_grant instead. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. refresh_stock_prices does this too; this tool does only this, for one grant or all.",
  kind: 'write',
  input: {
    grant: z
      .string()
      .min(1)
      .optional()
      .describe('Only this grant (name or id). Defaults to every grant.'),
  },
  output: {
    pending: z
      .array(
        z.object({
          row_id: z.string(),
          grant: z.string(),
          ticker: z.string(),
          vest_date: z.string(),
        }),
      )
      .describe('Vested rows without a price, before this call.'),
    locked: z.array(z.string()).describe('Row ids that got a price.'),
    failed: z.array(z.object({ row_id: z.string(), reason: z.string() })),
    error: z
      .string()
      .nullable()
      .describe(
        '"no-server" when no sync server is configured; null otherwise.',
      ),
  },
  async handler({ grant: ref }, ctx) {
    const data = await loadRsuData(ctx);
    const grants = ref ? [resolveGrant(data.grants, ref)] : data.grants;
    const today = ctx.today();
    const byGrant = new Map(grants.map(grant => [grant.id, grant] as const));
    const pending = data.events
      .filter(
        event =>
          byGrant.has(event.grant_id) &&
          event.actual_price == null &&
          event.vest_date <= today,
      )
      .map(event => ({
        row_id: event.id,
        grant: byGrant.get(event.grant_id)?.name ?? '',
        ticker: normalizeTicker(byGrant.get(event.grant_id)?.ticker ?? ''),
        vest_date: event.vest_date,
      }));

    if (ctx.dryRun || pending.length === 0) {
      return {
        data: { pending, locked: [], failed: [], error: null },
        text:
          pending.length === 0
            ? 'Every vested row already has a vest-date price.'
            : `Would look up the vest-date close for ${pending.length} rows: ${pending.map(p => `${p.ticker} ${p.vest_date}`).join(', ')}.`,
      };
    }

    const results = await Promise.all(
      grants.map(grant =>
        ctx.lootCore.send('rsu/lock-vest-prices', { grantId: grant.id }),
      ),
    );
    const locked = results.flatMap(result => result.locked);
    const failed = results.flatMap(result =>
      result.failed.map(f => ({ row_id: f.eventId, reason: f.reason })),
    );
    const error = results.find(result => result.error)?.error ?? null;
    const text =
      error === 'no-server'
        ? 'No sync server is configured, so vest-date prices cannot be looked up. Set vest_price with update_rsu_grant instead.'
        : `Locked the vest-date price of ${locked.length} rows` +
          (failed.length > 0
            ? `; ${failed.length} could not be priced (${[...new Set(failed.map(f => f.reason))].join(', ')})`
            : '') +
          '.';
    return { data: { pending, locked, failed, error }, text };
  },
});
