import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import { queryRows } from '#actual/query';
import { defineTool } from '#tools/registry';

const statementRow = z.object({
  id: z.string(),
  account: z.string(),
  pay_from: z.string(),
  closing_date: z.string().nullish(),
  statement_balance: z.number(),
  minimum_due: z.number().nullish(),
  due_date: z.string(),
  payment_amount: z.number().nullish(),
  schedule: z.string().nullish(),
});

const scheduleRow = z.object({
  id: z.string(),
  completed: z.boolean().nullish(),
});

export const getCardStatements = defineTool({
  name: 'get_card_statements',
  title: 'List recorded card statements',
  description:
    'List the credit card statements recorded with record_card_statement, newest due date first: the card, the closing and due dates (YYYY-MM-DD), the statement balance, minimum due and the amount that will be paid (major currency units, e.g. dollars, not cents, positive), the account it is paid from, and whether the payment is still to come, already paid, or nothing was owed. Use it to see which statements are in before recording more.',
  kind: 'read',
  input: {
    account: z
      .string()
      .min(1)
      .optional()
      .describe('Only this card account (name or id).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(24)
      .describe('Statements to list (default 24).'),
  },
  output: {
    statements: z.array(
      z.object({
        id: z.string(),
        account: z.string(),
        closing_date: z.string().nullable(),
        due_date: z.string(),
        statement_balance: z.number(),
        minimum_due: z.number().nullable(),
        payment_amount: z.number(),
        pay_from: z.string(),
        status: z.enum(['upcoming', 'paid', 'nothing-owed']),
      }),
    ),
  },
  async handler({ account, limit }, ctx) {
    const filterAccount = account
      ? (await createLookups(ctx).account(account)).id
      : null;
    const rows = await queryRows(
      ctx,
      ctx.api
        .q('card_statements')
        .filter(filterAccount ? { account: filterAccount } : {})
        .orderBy({ due_date: 'desc' })
        .limit(limit)
        .select('*'),
      statementRow,
    );
    const scheduleIds = rows.flatMap(row =>
      row.schedule ? [row.schedule] : [],
    );
    const schedules =
      scheduleIds.length === 0
        ? []
        : await queryRows(
            ctx,
            ctx.api
              .q('schedules')
              .filter({ id: { $oneof: scheduleIds } })
              .select(['id', 'completed']),
            scheduleRow,
          );
    const completed = new Map(
      schedules.map(s => [s.id, Boolean(s.completed)] as const),
    );
    const accountNames = new Map(
      (await ctx.api.getAccounts()).map(a => [a.id, a.name] as const),
    );
    const { toMajor, format } = ctx.amounts;

    const statements = rows.map(row => {
      const payment = row.payment_amount ?? row.statement_balance;
      return {
        id: row.id,
        account: accountNames.get(row.account) ?? row.account,
        closing_date: row.closing_date ?? null,
        due_date: row.due_date,
        statement_balance: toMajor(row.statement_balance),
        minimum_due: row.minimum_due == null ? null : toMajor(row.minimum_due),
        payment_amount: toMajor(payment),
        pay_from: accountNames.get(row.pay_from) ?? row.pay_from,
        status:
          payment === 0 || !row.schedule
            ? ('nothing-owed' as const)
            : completed.get(row.schedule)
              ? ('paid' as const)
              : ('upcoming' as const),
      };
    });

    const text =
      statements.length === 0
        ? 'No card statements are recorded.'
        : statements
            .map(
              s =>
                `${s.due_date} ${s.account}: ${format(s.payment_amount)} from ${s.pay_from} (${s.status}; statement balance ${format(s.statement_balance)}${s.closing_date ? `, closed ${s.closing_date}` : ''})`,
            )
            .join('\n');
    return { data: { statements }, text };
  },
});
