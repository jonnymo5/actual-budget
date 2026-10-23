import { z } from 'zod';

import { getAccountsWithBalances } from '#actual/accounts';
import {
  getFirstTransactionDate,
  loadAnalysisTransactions,
} from '#actual/analysis-data';
import { listScheduledEvents } from '#actual/schedule-events';
import { resolveCategoryIds } from '#actual/transactions';
import {
  addMonths,
  firstDayOf,
  lastDayOf,
  monthOf,
  monthsBetween,
} from '#analysis/dates';
import { projectCashFlow } from '#analysis/projection';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoMonth } from '#tools/schemas';

import { includeOffBudget } from './shared';

const MAX_HORIZON_MONTHS = 24;
const MAX_LISTED_EVENTS = 40;

const lowestSchema = z.object({
  month: z.string().describe('YYYY-MM.'),
  balance: z.number().describe('Major units.'),
});

export const cashFlowProjection = defineTool({
  name: 'cash_flow_projection',
  title: 'Project cash flow',
  description:
    "Project account balances forward from today. Amounts are in major currency units (e.g. dollars, not cents) and signed: money out is negative. Months are YYYY-MM, dates YYYY-MM-DD. It starts from each account's balance today and adds (1) every payment and deposit the Actual schedules expect, expanded exactly as Actual does, and (2) everything else at the average of the last few complete months, per account, with spending and income that schedules already cover left out so nothing is counted twice. Transfers between accounts are never averaged (only scheduled ones move money). It gives, per month, scheduled and average money in and out and the end-of-month balance for each account, plus the lowest month-end balance and the first month any account goes negative. The first row is the rest of the current month. Balances are month-end figures: a bill early in the month can dip lower in between. The averages are a plain trailing average, not a forecast of one-off purchases; exclude_categories and include_baseline let you change that assumption. Past-due schedules are assumed due today.",
  kind: 'read',
  input: {
    months: z
      .number()
      .int()
      .min(1)
      .max(MAX_HORIZON_MONTHS)
      .default(3)
      .describe('Whole months to project after the current one (default 3).'),
    through_month: isoMonth
      .optional()
      .describe(
        'Project through the end of this month instead, YYYY-MM (for "through March"). Overrides months.',
      ),
    average_months: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(3)
      .describe(
        'How many complete months before this one to average for everything not on a schedule (default 3).',
      ),
    include_baseline: z
      .boolean()
      .default(true)
      .describe(
        'Include the average for everything not on a schedule. False projects the scheduled items alone.',
      ),
    exclude_categories: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        'Categories (ids or exact names) to leave out of the averages, e.g. a one-off purchase that will not repeat.',
      ),
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only this account (id from list_accounts). Omit for every on-budget account.',
      ),
    include_off_budget: includeOffBudget,
  },
  output: {
    as_of: z.string().describe('Today, YYYY-MM-DD.'),
    end_month: z.string(),
    starting_balance: z
      .number()
      .describe('Total of the accounts shown, today, major units.'),
    months: z.array(
      z.object({
        month: z.string(),
        days: z
          .number()
          .describe(
            'Days of this month after today that the projection covers.',
          ),
        scheduled_in: z
          .number()
          .describe('Deposits expected by schedules, major units.'),
        scheduled_out: z
          .number()
          .describe('Payments expected by schedules, major units, negative.'),
        baseline_in: z
          .number()
          .describe('Average money in from everything not on a schedule.'),
        baseline_out: z
          .number()
          .describe(
            'Average money out from everything not on a schedule, negative.',
          ),
        net: z.number(),
        ending_balance: z
          .number()
          .describe('Total across the accounts shown, end of the month.'),
        accounts: z.array(
          z.object({
            account_id: z.string(),
            name: z.string(),
            ending_balance: z.number(),
          }),
        ),
      }),
    ),
    lowest_month_end: lowestSchema.describe('The lowest total at a month end.'),
    first_negative_month: z
      .string()
      .nullable()
      .describe('The first month whose end total is below zero; null if none.'),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        starting_balance: z.number(),
        ending_balance: z.number(),
        lowest_month_end: lowestSchema,
        first_negative_month: z.string().nullable(),
      }),
    ),
    baseline: z.object({
      months_averaged: z
        .number()
        .describe('0 when there was no complete month of history to average.'),
      monthly_in: z
        .number()
        .describe('Average money in per month that is not on a schedule.'),
      monthly_out: z
        .number()
        .describe(
          'Average money out per month that is not on a schedule, negative.',
        ),
      top_spending: z
        .array(z.object({ category: z.string(), monthly_average: z.number() }))
        .describe('The biggest spending categories in the average.'),
    }),
    scheduled_events: z
      .array(
        z.object({
          date: z.string(),
          name: z.string().nullable(),
          account: z.string().nullable(),
          amount: z.number().describe('Major units, signed.'),
          overdue: z.boolean(),
        }),
      )
      .describe(
        `The first ${MAX_LISTED_EVENTS} scheduled items counted, soonest first.`,
      ),
    scheduled_event_count: z.number(),
    notes: z.array(z.string()).describe('Assumptions and caveats.'),
  },
  async handler(input, ctx) {
    const today = ctx.today();
    const currentMonth = monthOf(today);
    const endMonth =
      input.through_month ?? addMonths(currentMonth, input.months);
    if (endMonth < currentMonth) {
      throw toolError(
        `through_month ${endMonth} is before the current month (${currentMonth}).`,
      );
    }
    if (monthsBetween(currentMonth, endMonth) > MAX_HORIZON_MONTHS) {
      throw toolError(
        `The horizon may be at most ${MAX_HORIZON_MONTHS} months ahead (through ${addMonths(currentMonth, MAX_HORIZON_MONTHS)}).`,
      );
    }

    const { accounts: allAccounts } = await getAccountsWithBalances(ctx, {
      includeClosed: false,
    });
    const chosen = input.account_id
      ? allAccounts.filter(account => account.id === input.account_id)
      : allAccounts.filter(
          account => input.include_off_budget || !account.off_budget,
        );
    if (input.account_id && chosen.length === 0) {
      throw toolError(
        `unknown or closed account_id "${input.account_id}". Open accounts: ${allAccounts.map(a => `${a.name} (${a.id})`).join(', ') || 'none'}.`,
      );
    }
    if (chosen.length === 0) {
      throw toolError('There are no open accounts to project.');
    }
    const accounts = chosen.map(account => ({
      id: account.id,
      name: account.name,
      balance: ctx.amounts.toMinor(account.balance),
    }));
    const shown = new Set(accounts.map(account => account.id));
    const notes: string[] = [];

    const events = await listScheduledEvents(ctx, {
      from: today,
      to: lastDayOf(endMonth),
    });
    const inScope = events.filter(
      event =>
        (event.account_id !== null && shown.has(event.account_id)) ||
        (event.transfer_account_id !== null &&
          shown.has(event.transfer_account_id)),
    );
    const unplaced = events.filter(
      event => event.account_id === null && event.transfer_account_id === null,
    );
    if (unplaced.length > 0) {
      notes.push(
        `${unplaced.length} scheduled item(s) are not tied to an account and were left out.`,
      );
    }
    if (inScope.some(event => event.overdue)) {
      notes.push(
        'Some schedules are past due and not yet entered; they are counted as due today.',
      );
    }

    // The average covers whole months before this one, but never months from
    // before the budget had any data.
    const firstDate = await getFirstTransactionDate(ctx);
    const windowFirstMonth = addMonths(currentMonth, -input.average_months);
    const monthsOfHistory = firstDate
      ? Math.min(
          input.average_months,
          monthsBetween(
            monthOf(firstDate) > windowFirstMonth
              ? monthOf(firstDate)
              : windowFirstMonth,
            currentMonth,
          ),
        )
      : 0;
    const averaging = input.include_baseline && monthsOfHistory > 0;
    if (input.include_baseline && monthsOfHistory === 0) {
      notes.push(
        'There is no complete month of history yet, so only scheduled items are projected.',
      );
    } else if (averaging && monthsOfHistory < input.average_months) {
      notes.push(
        `Only ${monthsOfHistory} complete month(s) of history exist, so the averages use ${monthsOfHistory}.`,
      );
    }

    const excludedCategories = new Set<string>();
    for (const category of input.exclude_categories ?? []) {
      for (const id of await resolveCategoryIds(ctx, category)) {
        excludedCategories.add(id);
      }
    }
    // Whatever a schedule pays or collects is projected from the schedule, so
    // the same payees are dropped from the averages.
    const scheduledPayees = new Set(
      events.flatMap(event => (event.payee_id ? [event.payee_id] : [])),
    );
    if (events.some(event => event.payee_id === null)) {
      notes.push(
        'Schedules without a payee cannot be matched to past transactions, so what they cover may also be in the averages.',
      );
    }

    const baseline = averaging
      ? (
          await loadAnalysisTransactions(ctx, {
            startDate: firstDayOf(windowFirstMonth),
            endDate: lastDayOf(addMonths(currentMonth, -1)),
            accountId: input.account_id,
            includeOffBudget:
              input.include_off_budget || Boolean(input.account_id),
          })
        ).filter(
          transaction =>
            !(
              transaction.payee_id && scheduledPayees.has(transaction.payee_id)
            ) &&
            !(
              transaction.category_id &&
              excludedCategories.has(transaction.category_id)
            ),
        )
      : [];

    const projection = projectCashFlow({
      today,
      endMonth,
      accounts,
      events: inScope,
      baseline,
      baselineMonths: Math.max(monthsOfHistory, 1),
      includeBaseline: averaging,
      money: ctx.amounts,
    });

    const { format } = ctx.amounts;
    const accountNames = new Map(allAccounts.map(a => [a.id, a.name]));
    const lines = [
      `Cash flow from ${today} through ${endMonth} for ${accounts.map(a => a.name).join(', ')}: starting ${format(projection.starting_balance)}, ending ${format(projection.months[projection.months.length - 1].ending_balance)}, lowest month-end ${format(projection.lowest_month_end.balance)} (${projection.lowest_month_end.month}).${projection.first_negative_month ? ` Goes negative in ${projection.first_negative_month}.` : ''}`,
      ...projection.months.map(
        month =>
          `- ${month.month}${month.days < 28 && month.month === currentMonth ? ` (${month.days} days left)` : ''}: scheduled ${format(month.scheduled_in)} in / ${format(month.scheduled_out)} out, average ${format(month.baseline_in)} in / ${format(month.baseline_out)} out, ending ${format(month.ending_balance)}${accounts.length > 1 ? ` (${month.accounts.map(a => `${a.name} ${format(a.ending_balance)}`).join(', ')})` : ''}`,
      ),
      ...notes,
    ];

    return {
      data: {
        as_of: today,
        end_month: endMonth,
        starting_balance: projection.starting_balance,
        months: projection.months,
        lowest_month_end: projection.lowest_month_end,
        first_negative_month: projection.first_negative_month,
        accounts: projection.accounts,
        baseline: {
          ...projection.baseline,
          months_averaged: averaging ? monthsOfHistory : 0,
        },
        scheduled_events: inScope.slice(0, MAX_LISTED_EVENTS).map(event => ({
          date: event.date,
          name: event.name,
          account: event.account_id
            ? (accountNames.get(event.account_id) ?? null)
            : null,
          amount: ctx.amounts.toMajor(event.amount),
          overdue: event.overdue,
        })),
        scheduled_event_count: inScope.length,
        notes,
      },
      text: lines.join('\n'),
    };
  },
});
