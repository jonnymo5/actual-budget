import { z } from 'zod';

import { listSchedules } from '#actual/schedules';
import { defineTool } from '#tools/registry';

export const getSchedules = defineTool({
  name: 'get_schedules',
  title: 'List schedules',
  description:
    'List scheduled (recurring or one-off) transactions, soonest next date first: bills, subscriptions, paychecks. Each has a next date (YYYY-MM-DD), a payee and account, an amount in major currency units (e.g. dollars, not cents; negative is a payment) that may be exact, approximate or a range, and a plain-language recurrence. Completed schedules are hidden unless include_completed is true.',
  kind: 'read',
  input: {
    include_completed: z
      .boolean()
      .default(false)
      .describe('Also list schedules that have finished.'),
  },
  output: {
    schedules: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        next_date: z.string().nullable().describe('YYYY-MM-DD.'),
        completed: z.boolean(),
        posts_transaction: z
          .boolean()
          .describe(
            'True when it enters the transaction by itself on its date.',
          ),
        payee_id: z.string().nullable(),
        payee: z.string().nullable(),
        account_id: z.string().nullable(),
        account: z.string().nullable(),
        amount: z
          .number()
          .nullable()
          .describe(
            'Major units; the lower bound when amount_match is "between".',
          ),
        amount_upper: z
          .number()
          .nullable()
          .describe('Upper bound, only when amount_match is "between".'),
        amount_match: z.enum(['exact', 'approximate', 'between']).nullable(),
        recurrence: z.object({
          description: z.string(),
          frequency: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']),
          interval: z.number(),
          start: z.string(),
          ends: z.string().nullable(),
        }),
      }),
    ),
  },
  async handler({ include_completed }, ctx) {
    const schedules = await listSchedules(ctx, {
      includeCompleted: include_completed,
    });

    const { format } = ctx.amounts;
    const amountText = (schedule: (typeof schedules)[number]) => {
      if (schedule.amount === null) return 'any amount';
      if (
        schedule.amount_match === 'between' &&
        schedule.amount_upper !== null
      ) {
        return `between ${format(schedule.amount)} and ${format(schedule.amount_upper)}`;
      }
      return `${schedule.amount_match === 'approximate' ? '~' : ''}${format(schedule.amount)}`;
    };
    const lines = schedules.map(schedule =>
      [
        schedule.next_date ?? '(no next date)',
        schedule.name ?? '(unnamed)',
        amountText(schedule),
        schedule.payee ?? '',
        schedule.account ?? '',
        schedule.recurrence.description,
        schedule.completed ? '(completed)' : '',
        `[id: ${schedule.id}]`,
      ]
        .filter(part => part !== '')
        .join(' | '),
    );

    return {
      data: { schedules },
      text: lines.length > 0 ? lines.join('\n') : 'No schedules.',
    };
  },
});
