import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import { planSchedule } from '#actual/schedule-create';
import type { ScheduleDraft } from '#actual/schedule-create';
import { upcomingDates } from '#actual/schedule-events';
import { describeRecurrence, listSchedules } from '#actual/schedules';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const MAX_SCHEDULES = 50;
const UPCOMING_SHOWN = 6;

const scheduleInput = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'A name for the schedule, such as "Mortgage". Names must be unique.',
    ),
  account: z
    .string()
    .min(1)
    .describe('The account the money leaves or arrives in (name or id).'),
  payee: z
    .string()
    .min(1)
    .describe(
      "Who is paid or who pays (a payee name or id; get_payees searches them). For money moved to one of the budget's own accounts, such as a credit card payment, give that account's name: Actual keeps a transfer payee for each account.",
    ),
  amount: z
    .number()
    .describe(
      'Major currency units (e.g. dollars, not cents), signed: negative for a payment, positive for a deposit. The lower end when amount_match is "between".',
    ),
  amount_match: z
    .enum(['exact', 'approximate', 'between'])
    .default('exact')
    .describe(
      '"exact": the amount is fixed. "approximate": about this amount (Actual allows a small difference when matching a transaction). "between": anything from amount to amount_upper, for bills that vary.',
    ),
  amount_upper: z
    .number()
    .optional()
    .describe(
      'Only for "between": the other end of the range, greater than amount (for payments that is the smaller payment: amount -60, amount_upper -40).',
    ),
  start_date: isoDate.describe(
    "YYYY-MM-DD. The date of a one-off schedule; for a repeating one, the first date it counts from (a monthly schedule with no days_of_month repeats on this date's day of the month, a weekly one on its weekday).",
  ),
  frequency: z
    .enum(['once', 'daily', 'weekly', 'monthly', 'yearly'])
    .describe('How often it happens.'),
  interval: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      'Every N days, weeks, months or years: 2 with "weekly" is every other week. Default 1.',
    ),
  days_of_month: z
    .array(z.number().int().min(-1).max(31))
    .min(1)
    .max(8)
    .optional()
    .describe(
      'Monthly schedules only: the days of the month it falls on, 1 to 31, or -1 for the last day. Several days make one schedule, e.g. [1, 15] for a paycheck twice a month. Months without a day (30 or 31) skip it.',
    ),
  weekend: z
    .enum(['none', 'before', 'after'])
    .default('none')
    .describe(
      'What to do when a date falls on a Saturday or Sunday. "after": move it to the next weekday (payments). "before": move it to the previous weekday (paychecks). Default "none".',
    ),
  end_after_occurrences: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Stop after this many occurrences. Not with end_date.'),
  end_date: isoDate
    .optional()
    .describe(
      'YYYY-MM-DD. Stop after this date. Not with end_after_occurrences.',
    ),
  posts_transaction: z
    .boolean()
    .default(false)
    .describe(
      'True: Actual enters the transaction by itself on the date. False (the default): it only reminds, and forecasts the amount, until the transaction arrives from the bank.',
    ),
});

const resultSchema = z.object({
  status: z
    .enum(['ready', 'skipped'])
    .describe(
      '"ready": passes every check and will be created (or was). "skipped": cannot be created, see skipped_reason.',
    ),
  name: z.string(),
  account: z.string().nullable(),
  payee: z.string().nullable(),
  amount: z.number().describe('Major units; the lower end of a range.'),
  amount_upper: z.number().nullable(),
  amount_match: z.enum(['exact', 'approximate', 'between']),
  posts_transaction: z.boolean(),
  recurrence: z
    .string()
    .nullable()
    .describe('The recurrence in plain words; null when skipped.'),
  upcoming_dates: z
    .array(z.string())
    .describe(
      `YYYY-MM-DD. The next ${UPCOMING_SHOWN} dates, weekend moves applied, as Actual's projections will use them.`,
    ),
  skipped_reason: z.string().nullable(),
  created: z.boolean().describe('True once the schedule really exists.'),
  schedule_id: z.string().nullable(),
  next_date: z
    .string()
    .nullable()
    .describe('YYYY-MM-DD. The next date Actual itself reports, once created.'),
});

type ScheduleResult = z.output<typeof resultSchema>;

export const createSchedules = defineTool({
  name: 'create_schedules',
  title: 'Create schedules',
  description: `Creates schedules: expected recurring or one-off payments and deposits such as a mortgage, a paycheck, a card payment or a subscription. Schedules are what get_schedules lists and what cash_flow_projection uses to place each payment on its date, so the more of the budget's regular flows are scheduled, the more exact its projections are. Give each as a name (unique), an account, a payee, a signed amount and a start_date (YYYY-MM-DD), plus how it repeats: frequency once, daily, weekly, monthly or yearly, an interval, days_of_month for a monthly one (several days, e.g. a paycheck on the 1st and the 15th, make a single schedule; -1 is the last day), a weekend rule (move to the next or previous weekday), and an optional end (after N occurrences, or on a date). Amounts are in major currency units (e.g. dollars, not cents): negative for a payment, positive for a deposit; use amount_match "approximate" or "between" for a bill that varies. For a payment to one of the budget's own accounts (paying a credit card) give that account's name as the payee. posts_transaction (default false) makes Actual enter the transaction by itself on the date; leave it false when the bank import brings the transaction in. The preview lists each schedule with its recurrence in words and its next ${UPCOMING_SHOWN} dates so the dates can be checked before anything is created; an entry that cannot be created is skipped with the reason and the others still go ahead. At most ${MAX_SCHEDULES} per call. This only adds schedules; it does not change or delete existing ones.`,
  kind: 'write',
  input: {
    schedules: z
      .array(scheduleInput)
      .min(1)
      .max(MAX_SCHEDULES)
      .describe('The schedules to create.'),
  },
  output: {
    requested: z.number(),
    ready_count: z.number(),
    skipped_count: z.number(),
    created_count: z
      .number()
      .describe('Schedules created; always 0 for a preview.'),
    schedules: z.array(resultSchema),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const lookups = createLookups(ctx);
    const existing = await listSchedules(ctx, { includeCompleted: true });
    const takenNames = new Set(
      existing.flatMap(schedule =>
        schedule.name ? [schedule.name.trim()] : [],
      ),
    );
    const from = ctx.today();

    const warnings: string[] = [];
    const results: ScheduleResult[] = [];
    const drafts = new Map<number, ScheduleDraft>();

    for (const [index, request] of input.schedules.entries()) {
      const plan = await planSchedule(request, {
        lookups,
        amounts: ctx.amounts,
        takenNames,
      });
      const base = {
        name: request.name.trim(),
        amount: request.amount,
        amount_upper: request.amount_upper ?? null,
        amount_match: request.amount_match,
        posts_transaction: request.posts_transaction,
        created: false,
        schedule_id: null,
        next_date: null,
      };
      if ('reason' in plan) {
        results.push({
          ...base,
          status: 'skipped',
          account: null,
          payee: null,
          recurrence: null,
          upcoming_dates: [],
          skipped_reason: plan.reason,
        });
        continue;
      }

      const { draft } = plan;
      drafts.set(index, draft);
      warnings.push(...draft.warnings);
      if (typeof draft.date === 'string' && draft.date < from) {
        warnings.push(
          `${draft.name}: ${draft.date} is already past, so this one-off schedule will show as overdue.`,
        );
      }
      const similar = existing.find(
        schedule =>
          !schedule.completed &&
          schedule.account_id === draft.account.id &&
          schedule.payee_id === draft.payee.id &&
          schedule.amount === request.amount,
      );
      if (similar) {
        warnings.push(
          `${draft.name}: looks like the existing schedule "${similar.name ?? '(unnamed)'}" (same account, payee and amount). Check it is not a duplicate.`,
        );
      }
      results.push({
        ...base,
        status: 'ready',
        account: draft.account.name,
        payee: draft.payee.name,
        recurrence: describeRecurrence(draft.date).description,
        upcoming_dates: upcomingDates(draft.date, {
          // Look ahead from today, or from the start date if that is later.
          from:
            typeof draft.date === 'string' || draft.date.start < from
              ? from
              : draft.date.start,
          count: UPCOMING_SHOWN,
        }),
        skipped_reason: null,
      });
    }

    if (!ctx.dryRun) {
      for (const [index, draft] of drafts) {
        try {
          results[index].schedule_id = await ctx.api.createSchedule({
            name: draft.name,
            posts_transaction: draft.postsTransaction,
            account: draft.account.id,
            payee: draft.payee.id,
            amount: draft.amount,
            amountOp: draft.amountOp,
            date: draft.date,
          });
          results[index].created = true;
        } catch (error) {
          results[index].status = 'skipped';
          results[index].skipped_reason =
            `Actual refused it: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      // Read back the date Actual itself worked out for each new schedule.
      const nextDates = new Map(
        (await listSchedules(ctx, { includeCompleted: true })).map(schedule => [
          schedule.id,
          schedule.next_date,
        ]),
      );
      for (const result of results) {
        if (result.schedule_id) {
          result.next_date = nextDates.get(result.schedule_id) ?? null;
        }
      }
    }

    const count = (status: ScheduleResult['status']) =>
      results.filter(result => result.status === status).length;
    const created = results.filter(result => result.created).length;
    const { format } = ctx.amounts;

    const describe = (result: ScheduleResult) => {
      const tag = result.created
        ? 'CREATED'
        : { ready: 'ready', skipped: 'SKIPPED' }[result.status];
      if (result.status === 'skipped') {
        return `[${tag}] ${result.name}: ${result.skipped_reason}`;
      }
      const amount =
        result.amount_match === 'between' && result.amount_upper !== null
          ? `between ${format(result.amount)} and ${format(result.amount_upper)}`
          : `${result.amount_match === 'approximate' ? '~' : ''}${format(result.amount)}`;
      return [
        `[${tag}] ${result.name} | ${amount} | ${result.payee} | ${result.account} | ${result.recurrence}${result.posts_transaction ? ' | posts the transaction itself' : ''}`,
        `    next: ${result.upcoming_dates.join(', ')}${result.schedule_id ? `  [id: ${result.schedule_id}]` : ''}`,
      ].join('\n');
    };

    const header = ctx.dryRun
      ? `Would create ${count('ready')} of ${results.length} schedule(s); ${count('skipped')} skipped.`
      : `Created ${created} of ${results.length} schedule(s); ${count('skipped')} skipped.`;

    return {
      data: {
        requested: results.length,
        ready_count: count('ready'),
        skipped_count: count('skipped'),
        created_count: created,
        schedules: results,
        warnings,
      },
      text: [
        header,
        ...results.map(describe),
        ...warnings.map(warning => `Warning: ${warning}`),
      ].join('\n'),
    };
  },
});
