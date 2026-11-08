import {
  DEPOSIT_WINDOW_AFTER_DAYS,
  DEPOSIT_WINDOW_BEFORE_DAYS,
  normalizeTicker,
  planDepositMatches,
} from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import {
  buildGrantView,
  grantViewSchema,
  loadRsuData,
  priceByTicker,
  resolveGrant,
} from '#actual/rsu';
import { defineTool } from '#tools/registry';

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const matchRsuDeposits = defineTool({
  name: 'match_rsu_deposits',
  title: 'Match deposits to past vests',
  description:
    "Record what each past vest of an RSU grant really paid, by pairing every vested row that has no recorded net with the deposit from the grant's payee into the grant's account that landed closest to its vest date (from 2 days before to 10 days after). The deposit's amount becomes the row's actual net, which then counts in the grant's paid-out total instead of an estimate. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. The preview shows each pairing so it can be checked first; use update_rsu_grant to set a row by hand when a pairing is wrong.",
  kind: 'write',
  input: {
    grant: z.string().min(1).describe('The grant (name or id).'),
  },
  output: {
    grant_id: z.string(),
    matches: z.array(
      z.object({
        row_id: z.string(),
        vest_date: z.string(),
        transaction_id: z.string(),
        deposit_date: z.string(),
        amount: z.number().describe('Major units.'),
      }),
    ),
    unmatched: z.array(z.object({ row_id: z.string(), vest_date: z.string() })),
    grant: grantViewSchema,
  },
  async handler({ grant: ref }, ctx) {
    const data = await loadRsuData(ctx);
    const grant = resolveGrant(data.grants, ref);
    const today = ctx.today();
    const pending = data.events.filter(
      event =>
        event.grant_id === grant.id &&
        event.actual_net == null &&
        event.vest_date < today,
    );
    const { toMajor, format } = ctx.amounts;

    let matches: Array<{
      row_id: string;
      vest_date: string;
      transaction_id: string;
      deposit_date: string;
      amount: number;
    }> = [];
    let unmatched = pending.map(event => ({
      row_id: event.id,
      vest_date: event.vest_date,
    }));

    if (pending.length > 0) {
      const dates = pending.map(event => event.vest_date).sort();
      const transactions = await ctx.api.getTransactions(
        grant.account,
        shiftDays(dates[0], -DEPOSIT_WINDOW_BEFORE_DAYS),
        shiftDays(dates[dates.length - 1], DEPOSIT_WINDOW_AFTER_DAYS),
      );
      const deposits = transactions
        .filter(
          t => t.payee === grant.payee && (t.amount ?? 0) > 0 && !t.is_parent,
        )
        .map(t => ({ id: t.id, date: t.date, amount: t.amount ?? 0 }));
      const plan = planDepositMatches(pending, deposits);
      matches = plan.matched.map(match => ({
        row_id: match.eventId,
        vest_date: match.vestDate,
        transaction_id: match.transactionId,
        deposit_date: match.depositDate,
        amount: toMajor(match.amount),
      }));
      const byId = new Map(pending.map(event => [event.id, event] as const));
      unmatched = plan.unmatched.map(id => ({
        row_id: id,
        vest_date: byId.get(id)?.vest_date ?? '',
      }));

      if (!ctx.dryRun) {
        await ctx.lootCore.send('rsu/match-deposits', { grantId: grant.id });
      }
    }

    const after = ctx.dryRun ? data : await loadRsuData(ctx);
    const grantNow = resolveGrant(after.grants, grant.id);
    const view = buildGrantView(
      ctx,
      grantNow,
      after.events,
      priceByTicker(after.prices).get(normalizeTicker(grantNow.ticker)) ?? null,
    );

    const lines = [
      pending.length === 0
        ? `Every past vest of "${grant.name}" already has a recorded net.`
        : `${ctx.dryRun ? 'Would record' : 'Recorded'} ${matches.length} of ${pending.length} past vests of "${grant.name}" from deposits:`,
      ...matches.map(
        m =>
          `  vest ${m.vest_date} ← deposit ${m.deposit_date} ${format(m.amount)} [tx ${m.transaction_id}]`,
      ),
      ...unmatched.map(u => `  vest ${u.vest_date}: no deposit found nearby`),
    ];
    return {
      data: { grant_id: grant.id, matches, unmatched, grant: view },
      text: lines.join('\n'),
    };
  },
});
