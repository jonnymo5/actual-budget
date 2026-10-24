import { z } from 'zod';

import { loadAnalysisTransactions } from '#actual/analysis-data';
import { listSchedules } from '#actual/schedules';
import { assertKnownAccount } from '#actual/transactions';
import { addMonths, firstDayOf, monthOf } from '#analysis/dates';
import { detectRecurring } from '#analysis/recurring';
import { defineTool } from '#tools/registry';

import { includeOffBudget } from './shared';

const chargeSchema = z.object({
  payee_id: z.string(),
  payee: z.string(),
  category: z
    .string()
    .nullable()
    .describe('The category most of the charges were filed under.'),
  direction: z.enum(['spending', 'income']),
  cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']),
  typical_amount: z
    .number()
    .describe('The median charge, major units, signed.'),
  amount_variability: z
    .enum(['fixed', 'variable'])
    .describe(
      'fixed: the same price each time. variable: it moves around, like a utility bill.',
    ),
  occurrences: z.number(),
  first_date: z.string(),
  last_date: z.string(),
  last_amount: z.number().describe('Major units, signed.'),
  next_expected_date: z
    .string()
    .describe('YYYY-MM-DD: one cadence after the last charge.'),
  days_since_last: z.number(),
  status: z
    .enum(['active', 'stopped'])
    .describe(
      'stopped: more than one and a half cadences have passed with no charge.',
    ),
  price_change: z
    .object({
      from: z
        .number()
        .describe('The earlier steady price, major units, signed.'),
      to: z.number().describe('The new steady price, major units, signed.'),
      percent_change: z
        .number()
        .describe('Positive when the charge got bigger.'),
      changed_on: z
        .string()
        .describe('The first charge at the new price, YYYY-MM-DD.'),
    })
    .nullable()
    .describe('Set when the price moved from one steady level to another.'),
  estimated_monthly_amount: z.number().describe('Major units, signed.'),
  estimated_yearly_amount: z.number().describe('Major units, signed.'),
  schedule: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable()
    .describe('The Actual schedule that already covers this payee, if any.'),
});

export const detectRecurringTool = defineTool({
  name: 'detect_recurring',
  title: 'Detect recurring charges',
  description:
    'Find subscriptions, bills and regular income by looking for payees that charge on a steady cadence (weekly, biweekly, monthly, quarterly or yearly) for similar amounts, alongside the schedules already set up in Actual. Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative, income is positive. Dates are YYYY-MM-DD. For each recurring charge it gives the cadence, typical amount, when the next one is expected, and an estimated monthly and yearly cost. It flags charges that stopped (a cadence or more has passed with none) and charges whose price changed from one steady level to another. Active charges come first, the costliest first. Charges that vary a lot (groceries) are not treated as recurring; utility-style bills that vary a little are, marked "variable". Transfers are ignored. Yearly charges need a lookback of at least 13 months to be seen twice.',
  kind: 'read',
  input: {
    lookback_months: z
      .number()
      .int()
      .min(3)
      .max(36)
      .default(18)
      .describe('How many whole months of history to examine (default 18).'),
    min_occurrences: z
      .number()
      .int()
      .min(2)
      .max(12)
      .default(3)
      .describe(
        'Times a payee must have charged before it counts as recurring (default 3; yearly charges need only 2).',
      ),
    include_stopped: z
      .boolean()
      .default(true)
      .describe(
        'Also list charges that appear to have stopped (default true).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Recurring charges to list (default 50).'),
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only this account (id from list_accounts). Omit for all accounts.',
      ),
    include_off_budget: includeOffBudget,
  },
  output: {
    as_of: z.string().describe('Today, YYYY-MM-DD.'),
    lookback_start: z.string().describe('The first day examined, YYYY-MM-DD.'),
    total_found: z
      .number()
      .describe(
        'Recurring charges found, before the limit and the stopped filter.',
      ),
    active_count: z.number(),
    stopped_count: z.number(),
    price_change_count: z.number(),
    monthly_spending: z
      .number()
      .describe(
        'What the active recurring spending costs per month, major units, negative.',
      ),
    monthly_income: z
      .number()
      .describe(
        'What the active recurring income brings per month, major units.',
      ),
    charges: z.array(chargeSchema),
    schedules: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          payee: z.string().nullable(),
          account: z.string().nullable(),
          amount: z
            .number()
            .nullable()
            .describe('Major units, signed; the lower bound of a range.'),
          next_date: z.string().nullable(),
          recurrence: z.string(),
        }),
      )
      .describe('The schedules already set up in Actual (not completed).'),
  },
  async handler(input, ctx) {
    const today = ctx.today();
    const start = firstDayOf(addMonths(monthOf(today), -input.lookback_months));
    if (input.account_id) await assertKnownAccount(ctx, input.account_id);

    const schedules = await listSchedules(ctx, { includeCompleted: false });
    const schedulesByPayee = new Map(
      schedules.flatMap(schedule =>
        schedule.payee_id
          ? [
              [
                schedule.payee_id,
                { id: schedule.id, name: schedule.name },
              ] as const,
            ]
          : [],
      ),
    );
    const transactions = await loadAnalysisTransactions(ctx, {
      startDate: start,
      endDate: today,
      accountId: input.account_id,
      includeOffBudget: input.include_off_budget,
    });
    const report = detectRecurring({
      transactions,
      today,
      minOccurrences: input.min_occurrences,
      schedulesByPayee,
      money: ctx.amounts,
    });

    const stopped = report.charges.filter(
      charge => charge.status === 'stopped',
    );
    const listed = report.charges
      .filter(charge => input.include_stopped || charge.status === 'active')
      .slice(0, input.limit);
    const { format } = ctx.amounts;
    const lines = [
      `${report.charges.length} recurring charge(s) since ${start} (${report.charges.length - stopped.length} active, ${stopped.length} stopped). Active spending about ${format(report.monthly_spending)}/month, income about ${format(report.monthly_income)}/month.`,
      ...listed.map(
        charge =>
          `- ${charge.payee}: ${format(charge.typical_amount)} ${charge.cadence}${charge.amount_variability === 'variable' ? ' (varies)' : ''}, ${charge.occurrences}x, last ${charge.last_date}, next expected ${charge.next_expected_date}, about ${format(charge.estimated_yearly_amount)}/year${charge.status === 'stopped' ? ' - STOPPED' : ''}${charge.price_change ? ` - PRICE CHANGE ${format(charge.price_change.from)} -> ${format(charge.price_change.to)} on ${charge.price_change.changed_on} (${charge.price_change.percent_change}%)` : ''}${charge.schedule ? ` [schedule: ${charge.schedule.name ?? charge.schedule.id}]` : ''}`,
      ),
      ...(schedules.length > 0
        ? [
            `Schedules set up in Actual: ${schedules
              .slice(0, 50)
              .map(
                schedule =>
                  `${schedule.name ?? schedule.payee ?? schedule.id} (${schedule.recurrence.description})`,
              )
              .join('; ')}`,
          ]
        : []),
    ];

    return {
      data: {
        as_of: today,
        lookback_start: start,
        total_found: report.charges.length,
        active_count: report.charges.length - stopped.length,
        stopped_count: stopped.length,
        price_change_count: report.charges.filter(c => c.price_change).length,
        monthly_spending: report.monthly_spending,
        monthly_income: report.monthly_income,
        charges: listed,
        schedules: schedules.slice(0, 50).map(schedule => ({
          id: schedule.id,
          name: schedule.name,
          payee: schedule.payee,
          account: schedule.account,
          amount: schedule.amount,
          next_date: schedule.next_date,
          recurrence: schedule.recurrence.description,
        })),
      },
      text: lines.join('\n'),
    };
  },
});
