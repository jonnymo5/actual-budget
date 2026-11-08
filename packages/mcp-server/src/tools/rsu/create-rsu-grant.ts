import {
  generateVestEvents,
  rsuScheduleName,
  sumShares,
  vestEventValue,
} from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import {
  buildGrantView,
  cadenceInputSchema,
  grantViewSchema,
  loadRsuData,
  priceByTicker,
  resolveGrant,
  tickerSchema,
  vestRowInputSchema,
  withholdingPercentSchema,
} from '#actual/rsu';
import type { VestRowInput } from '#actual/rsu';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const MAX_ROWS = 120;

const plannedRowSchema = z.object({
  vest_date: z.string().describe('YYYY-MM-DD.'),
  shares: z.number(),
  est_net: z
    .number()
    .nullable()
    .describe('Major units, from the vest price given or the current quote.'),
  will_schedule: z
    .boolean()
    .describe('True for future rows, which get a one-off schedule.'),
  schedule_name: z.string().nullable(),
});

export const createRsuGrant = defineTool({
  name: 'create_rsu_grant',
  title: 'Create an RSU grant',
  description:
    'Create an RSU (restricted stock unit) grant: a stock symbol, the shares granted, the tax withholding, and where the money lands (payee, account, income category). Give the vest rows either explicitly (vest_rows: date and shares each) or as a cadence (vest_start, frequency, periods, optional cliff), which is expanded into rows that add up to total_shares. Every future row becomes a non-posting one-off schedule named "RSU · <grant> · <date>" for its estimated net, so the income shows in get_schedules, cash_flow_projection and the Balance Forecast; past rows get their vest-date share price locked instead. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. The preview lists the rows with their estimated net at the current share price (set_stock_price or refresh_stock_prices if there is none yet).',
  kind: 'write',
  input: {
    name: z.string().trim().min(1).describe('A name for the grant, unique.'),
    ticker: tickerSchema.describe('The stock symbol, e.g. ACME.'),
    grant_date: isoDate.optional().describe('YYYY-MM-DD. When it was granted.'),
    total_shares: z
      .number()
      .positive()
      .optional()
      .describe(
        'Shares in the grant. Required with cadence; with vest_rows it defaults to their sum.',
      ),
    account: z
      .string()
      .min(1)
      .describe(
        'The account the net proceeds are deposited into (name or id).',
      ),
    payee: z
      .string()
      .min(1)
      .describe(
        'The payee the deposits arrive under (name or id), e.g. the broker. Used to match the real deposit.',
      ),
    create_payee: z
      .boolean()
      .default(false)
      .describe('Create the payee when no payee of that name exists.'),
    category: z
      .string()
      .min(1)
      .optional()
      .describe('Income category for the deposits (name or id).'),
    withholding_percent: withholdingPercentSchema,
    notes: z.string().optional(),
    vest_rows: z
      .array(vestRowInputSchema)
      .min(1)
      .max(MAX_ROWS)
      .optional()
      .describe('The vest rows, exactly as the brokerage shows them.'),
    cadence: cadenceInputSchema
      .optional()
      .describe('Generate the rows from a schedule instead of listing them.'),
  },
  output: {
    grant_id: z.string().nullable().describe('Set once created.'),
    grant: grantViewSchema.nullable().describe('The grant, once created.'),
    planned_rows: z.array(plannedRowSchema),
    total_shares: z.number(),
    payee_created: z
      .boolean()
      .describe('True when the payee was (or would be) created.'),
    locked_vests: z
      .number()
      .describe('Past rows whose vest-date price was locked after creation.'),
  },
  async handler(input, ctx) {
    if (!input.vest_rows === !input.cadence) {
      throw toolError(
        'Give either vest_rows or cadence, not both and not neither.',
      );
    }

    const lookups = createLookups(ctx);
    const account = await lookups.account(input.account);
    const category = input.category
      ? await lookups.category(input.category)
      : null;

    let payeeId: string | null = null;
    let payeeCreated = false;
    try {
      payeeId = (await lookups.payee(input.payee)).id;
    } catch (error) {
      if (!input.create_payee) throw error;
      payeeCreated = true;
    }

    let rows: VestRowInput[];
    let totalShares: number;
    if (input.cadence) {
      if (input.total_shares == null) {
        throw toolError(
          'total_shares is required when rows come from a cadence.',
        );
      }
      totalShares = input.total_shares;
      rows = generateVestEvents({
        totalShares,
        vestStart: input.cadence.vest_start,
        frequency: input.cadence.frequency,
        periods: input.cadence.periods,
        cliffPercent: input.cadence.cliff_percent,
        cliffMonths: input.cadence.cliff_months,
      }).map(row => ({ date: row.vest_date, shares: row.shares }));
      if (rows.length === 0) {
        throw toolError(
          'That cadence produces no vest rows; check periods and cliff_percent.',
        );
      }
    } else {
      rows = input.vest_rows ?? [];
      totalShares = input.total_shares ?? sumShares(rows);
    }

    const data = await loadRsuData(ctx);
    if (
      data.grants.some(g => g.name.toLowerCase() === input.name.toLowerCase())
    ) {
      throw toolError(
        `An RSU grant named "${input.name}" already exists; pick another name or use update_rsu_grant.`,
      );
    }
    const { toMinor, toMajor, format } = ctx.amounts;
    const price = priceByTicker(data.prices).get(input.ticker) ?? null;
    const withholdingRate = input.withholding_percent / 100;
    const today = ctx.today();

    const events = rows.map(row => ({
      vest_date: row.date,
      shares: row.shares,
      actual_price: row.vest_price == null ? null : toMinor(row.vest_price),
      actual_net: row.actual_net == null ? null : toMinor(row.actual_net),
    }));
    const planned = events.map(event => {
      const value = vestEventValue(
        event,
        { withholding_rate: withholdingRate },
        price,
      );
      const future = event.vest_date >= today;
      return {
        vest_date: event.vest_date,
        shares: event.shares,
        est_net: value ? toMajor(value.net) : null,
        will_schedule: future && value != null,
        schedule_name: future
          ? rsuScheduleName(input.name, event.vest_date)
          : null,
      };
    });

    const header =
      `${ctx.dryRun ? 'Would create' : 'Created'} RSU grant "${input.name}" (${input.ticker}): ${totalShares} shares, ${input.withholding_percent}% withheld, deposits from ${payeeCreated ? `new payee "${input.payee}"` : input.payee} into ${account.name}` +
      (category ? ` as ${category.name}` : '') +
      (price ? '' : '; no share price yet, so no schedules until one is set') +
      '.';
    const rowLines = planned.map(
      row =>
        `  ${row.vest_date}: ${row.shares} shares` +
        (row.est_net == null ? '' : ` → ~${format(row.est_net)} net`) +
        (row.will_schedule
          ? ' (schedule)'
          : row.vest_date < today
            ? ' (vested)'
            : ''),
    );

    if (ctx.dryRun) {
      return {
        data: {
          grant_id: null,
          grant: null,
          planned_rows: planned,
          total_shares: totalShares,
          payee_created: payeeCreated,
          locked_vests: 0,
        },
        text: [header, ...rowLines].join('\n'),
      };
    }

    if (payeeId == null) {
      payeeId = await ctx.api.createPayee({ name: input.payee.trim() });
    }
    const grantId = await ctx.lootCore.send('rsu-grant/create', {
      grant: {
        name: input.name,
        ticker: input.ticker,
        grant_date: input.grant_date ?? null,
        total_shares: totalShares,
        account: account.id,
        category: category?.id ?? null,
        payee: payeeId,
        withholding_rate: withholdingRate,
        notes: input.notes ?? null,
      },
      events,
    });
    const lock = await ctx.lootCore.send('rsu/lock-vest-prices', { grantId });

    const after = await loadRsuData(ctx);
    const grant = buildGrantView(
      ctx,
      resolveGrant(after.grants, grantId),
      after.events,
      priceByTicker(after.prices).get(input.ticker) ?? null,
    );
    const lockLine =
      lock.locked.length > 0
        ? `Locked the vest-date price of ${lock.locked.length} past rows.`
        : lock.error === 'no-server'
          ? 'Past rows keep no vest price until a sync server is available (or set vest_price by hand).'
          : '';
    return {
      data: {
        grant_id: grantId,
        grant,
        planned_rows: planned,
        total_shares: totalShares,
        payee_created: payeeCreated,
        locked_vests: lock.locked.length,
      },
      text: [header, ...rowLines, lockLine, `[id: ${grantId}]`]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
