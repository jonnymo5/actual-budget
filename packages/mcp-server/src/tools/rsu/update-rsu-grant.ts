import { normalizeTicker } from '@actual-app/core/shared/rsu';
import type { RsuVestEventEntity } from '@actual-app/core/types/models';
import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import {
  buildGrantView,
  grantViewSchema,
  loadRsuData,
  priceByTicker,
  resolveGrant,
  tickerSchema,
  vestRowInputSchema,
  withholdingPercentSchema,
} from '#actual/rsu';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const rowRef = z
  .string()
  .min(1)
  .describe(
    'A vest row, by id (from get_rsu_grants) or by its date YYYY-MM-DD.',
  );

const rowChangeSchema = z.object({
  row: rowRef,
  date: isoDate.optional().describe('New vest date.'),
  shares: z.number().positive().optional(),
  vest_price: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Share price on the vest date, major units; null clears it.'),
  actual_net: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe('The deposit that arrived, major units; null clears it.'),
});

const rowDiffSchema = z.object({
  id: z.string().nullable(),
  vest_date: z.string(),
  shares: z.number(),
  vest_price: z.number().nullable(),
  actual_net: z.number().nullable(),
});

type EventDraft = {
  id?: string;
  vest_date: string;
  shares: number;
  actual_price: number | null;
  actual_net: number | null;
};

export const updateRsuGrant = defineTool({
  name: 'update_rsu_grant',
  title: 'Update an RSU grant',
  description:
    'Change an RSU grant: its name, ticker, dates, shares, withholding, payee, account or category, and its vest rows (add_rows, update_rows by id or date, remove_rows). Schedules for future rows are created, moved or removed to match, and rows that have vested get their vest-date price locked. Give only the fields to change. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. The preview shows every row that would be added, changed or removed.',
  kind: 'write',
  input: {
    grant: z.string().min(1).describe('The grant to change (name or id).'),
    name: z.string().trim().min(1).optional(),
    ticker: tickerSchema.optional(),
    grant_date: isoDate.nullable().optional(),
    total_shares: z.number().positive().optional(),
    account: z.string().min(1).optional().describe('Name or id.'),
    payee: z.string().min(1).optional().describe('Name or id.'),
    category: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Income category (name or id); null removes it.'),
    withholding_percent: withholdingPercentSchema.optional(),
    notes: z.string().nullable().optional(),
    add_rows: z.array(vestRowInputSchema).max(120).optional(),
    update_rows: z.array(rowChangeSchema).max(120).optional(),
    remove_rows: z.array(rowRef).max(120).optional(),
  },
  output: {
    grant_id: z.string(),
    changed_fields: z.array(z.string()),
    rows_added: z.array(rowDiffSchema),
    rows_changed: z.array(
      z.object({ before: rowDiffSchema, after: rowDiffSchema }),
    ),
    rows_removed: z.array(rowDiffSchema),
    grant: grantViewSchema.describe(
      'The grant after the change (or as it is now, in a preview).',
    ),
    locked_vests: z.number(),
  },
  async handler(input, ctx) {
    const data = await loadRsuData(ctx);
    const existing = resolveGrant(data.grants, input.grant);
    const { toMinor, toMajor, format } = ctx.amounts;
    const lookups = createLookups(ctx);

    const grantChanges: Record<string, unknown> = {};
    const changedFields: string[] = [];
    const set = (field: string, value: unknown) => {
      grantChanges[field] = value;
      changedFields.push(field);
    };
    if (input.name != null && input.name !== existing.name) {
      set('name', input.name);
    }
    if (
      input.ticker != null &&
      input.ticker !== normalizeTicker(existing.ticker)
    ) {
      set('ticker', input.ticker);
    }
    if (
      input.grant_date !== undefined &&
      input.grant_date !== existing.grant_date
    ) {
      set('grant_date', input.grant_date);
    }
    if (
      input.total_shares != null &&
      input.total_shares !== existing.total_shares
    ) {
      set('total_shares', input.total_shares);
    }
    if (input.account != null) {
      const account = await lookups.account(input.account);
      if (account.id !== existing.account) set('account', account.id);
    }
    if (input.payee != null) {
      const payee = await lookups.payee(input.payee);
      if (payee.id !== existing.payee) set('payee', payee.id);
    }
    if (input.category !== undefined) {
      const id =
        input.category == null
          ? null
          : (await lookups.category(input.category)).id;
      if (id !== existing.category) set('category', id);
    }
    if (input.withholding_percent != null) {
      const rate = input.withholding_percent / 100;
      if (rate !== existing.withholding_rate) set('withholding_rate', rate);
    }
    if (input.notes !== undefined && input.notes !== existing.notes) {
      set('notes', input.notes);
    }

    // Rows: start from the current ones and apply the edits.
    const current = data.events
      .filter(event => event.grant_id === existing.id)
      .sort((a, b) => a.vest_date.localeCompare(b.vest_date));
    const findRow = (ref: string): RsuVestEventEntity => {
      const byId = current.find(row => row.id === ref.trim());
      if (byId) return byId;
      const byDate = current.filter(row => row.vest_date === ref.trim());
      if (byDate.length === 1) return byDate[0];
      if (byDate.length > 1) {
        throw toolError(
          `Several rows vest on ${ref}; use the row id: ${byDate.map(r => r.id).join(', ')}.`,
        );
      }
      throw toolError(
        `No vest row "${ref}" on this grant. get_rsu_grants lists its rows with ids and dates.`,
      );
    };

    const removedIds = new Set(
      (input.remove_rows ?? []).map(ref => findRow(ref).id),
    );
    const changes = new Map<string, EventDraft>();
    for (const change of input.update_rows ?? []) {
      const row = findRow(change.row);
      if (removedIds.has(row.id)) {
        throw toolError(`Row ${row.id} is both updated and removed.`);
      }
      const draft = changes.get(row.id) ?? {
        id: row.id,
        vest_date: row.vest_date,
        shares: row.shares,
        actual_price: row.actual_price,
        actual_net: row.actual_net,
      };
      if (change.date != null) draft.vest_date = change.date;
      if (change.shares != null) draft.shares = change.shares;
      if (change.vest_price !== undefined) {
        draft.actual_price =
          change.vest_price == null ? null : toMinor(change.vest_price);
      }
      if (change.actual_net !== undefined) {
        draft.actual_net =
          change.actual_net == null ? null : toMinor(change.actual_net);
      }
      changes.set(row.id, draft);
    }
    const added: EventDraft[] = (input.add_rows ?? []).map(row => ({
      vest_date: row.date,
      shares: row.shares,
      actual_price: row.vest_price == null ? null : toMinor(row.vest_price),
      actual_net: row.actual_net == null ? null : toMinor(row.actual_net),
    }));

    const desired: EventDraft[] = [
      ...current
        .filter(row => !removedIds.has(row.id))
        .map(
          row =>
            changes.get(row.id) ?? {
              id: row.id,
              vest_date: row.vest_date,
              shares: row.shares,
              actual_price: row.actual_price,
              actual_net: row.actual_net,
            },
        ),
      ...added,
    ];
    const rowsTouched =
      removedIds.size > 0 || changes.size > 0 || added.length > 0;
    if (changedFields.length === 0 && !rowsTouched) {
      throw toolError(
        'Nothing to change: every field given already has that value.',
      );
    }

    const view = (row: EventDraft) => ({
      id: row.id ?? null,
      vest_date: row.vest_date,
      shares: row.shares,
      vest_price: row.actual_price == null ? null : toMajor(row.actual_price),
      actual_net: row.actual_net == null ? null : toMajor(row.actual_net),
    });
    const rowsAdded = added.map(view);
    const rowsChanged = [...changes.values()]
      .map(after => {
        const before = current.find(row => row.id === after.id);
        return before
          ? {
              before: view({
                id: before.id,
                vest_date: before.vest_date,
                shares: before.shares,
                actual_price: before.actual_price,
                actual_net: before.actual_net,
              }),
              after: view(after),
            }
          : null;
      })
      .filter((item): item is NonNullable<typeof item> => item != null)
      .filter(
        item => JSON.stringify(item.before) !== JSON.stringify(item.after),
      );
    const rowsRemoved = current
      .filter(row => removedIds.has(row.id))
      .map(row =>
        view({
          id: row.id,
          vest_date: row.vest_date,
          shares: row.shares,
          actual_price: row.actual_price,
          actual_net: row.actual_net,
        }),
      );

    let lockedVests = 0;
    if (!ctx.dryRun) {
      await ctx.lootCore.send('rsu-grant/update', {
        grant: { id: existing.id, ...grantChanges },
        ...(rowsTouched ? { events: desired } : {}),
      });
      const lock = await ctx.lootCore.send('rsu/lock-vest-prices', {
        grantId: existing.id,
      });
      lockedVests = lock.locked.length;
    }

    const after = ctx.dryRun ? data : await loadRsuData(ctx);
    const grantNow = resolveGrant(after.grants, existing.id);
    const grant = buildGrantView(
      ctx,
      grantNow,
      after.events,
      priceByTicker(after.prices).get(normalizeTicker(grantNow.ticker)) ?? null,
    );

    const describeRow = (row: z.output<typeof rowDiffSchema>) =>
      `${row.vest_date}: ${row.shares} shares` +
      (row.vest_price == null ? '' : ` at ${format(row.vest_price)}`) +
      (row.actual_net == null ? '' : `, net ${format(row.actual_net)}`);
    const lines = [
      `${ctx.dryRun ? 'Would update' : 'Updated'} RSU grant "${existing.name}"` +
        (changedFields.length > 0 ? `: ${changedFields.join(', ')}` : '') +
        '.',
      ...rowsAdded.map(row => `  + ${describeRow(row)}`),
      ...rowsChanged.map(
        ({ before, after }) =>
          `  ~ ${describeRow(before)} → ${describeRow(after)}`,
      ),
      ...rowsRemoved.map(row => `  - ${describeRow(row)}`),
      ...(lockedVests > 0
        ? [`Locked the vest-date price of ${lockedVests} rows.`]
        : []),
    ];
    return {
      data: {
        grant_id: existing.id,
        changed_fields: changedFields,
        rows_added: rowsAdded,
        rows_changed: rowsChanged,
        rows_removed: rowsRemoved,
        grant,
        locked_vests: lockedVests,
      },
      text: lines.join('\n'),
    };
  },
});
