import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import { isToolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const MAX_STATEMENTS = 20;

const statementInput = z.object({
  account: z.string().min(1).describe('The credit card account (name or id).'),
  due_date: isoDate.describe('YYYY-MM-DD. The payment due date.'),
  statement_balance: z
    .number()
    .nonnegative()
    .describe(
      'The new balance printed on the statement, major units, as a positive amount owed (0 when nothing is owed).',
    ),
  closing_date: isoDate
    .optional()
    .describe('YYYY-MM-DD. The statement closing date, when printed.'),
  minimum_due: z
    .number()
    .nonnegative()
    .optional()
    .describe('The minimum payment due, major units, when printed.'),
  payment_amount: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'What will actually be paid, major units, when it is not the statement balance: a fixed or minimum autopay. Defaults to the statement balance.',
    ),
  pay_from: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The account the payment leaves (name or id). Defaults to the account the card's regular payment schedule pays from.",
    ),
});

const resultSchema = z.object({
  account: z.string(),
  due_date: z.string(),
  status: z.enum(['ready', 'recorded', 'skipped']),
  updates_existing: z
    .boolean()
    .describe('A statement with this due date was already recorded.'),
  pay_from: z.string().nullable(),
  payment_amount: z.number().nullable().describe('Major units, positive.'),
  regular_schedule: z
    .object({
      name: z.string().nullable(),
      next_date: z.string(),
      skipped: z
        .boolean()
        .describe(
          'Its next payment is (or would be) moved past this statement, so it is not counted twice.',
        ),
    })
    .nullable(),
  warning: z.string().nullable(),
  paid: z
    .boolean()
    .nullable()
    .describe(
      'A matching payment is already in the budget; null in a preview.',
    ),
  reason: z.string().nullable().describe('Why it was skipped.'),
});

export const recordCardStatement = defineTool({
  name: 'record_card_statement',
  title: 'Record credit card statements',
  description:
    "Record credit card statements read from the bank's PDF statement (the summary box: new balance, payment due date, and optionally the closing date and minimum payment), so the next payment from the paying account is forecast at its real amount. Transactions still come from the statement's .qbo/.ofx file through import_transactions; this only records the statement summary. Each statement becomes a one-off schedule named \"Card · <card> · <due date>\" for the amount that will be paid, and the card's regular recurring payment schedule is moved past that payment so cash_flow_projection and the Balance Forecast do not count it twice. Recording the same card and due date again corrects it. Once a payment to the card lands near the due date, the statement's schedule is marked done. Amounts are in major currency units (e.g. dollars, not cents), positive; dates are YYYY-MM-DD.",
  kind: 'write',
  input: {
    statements: z
      .array(statementInput)
      .min(1)
      .max(MAX_STATEMENTS)
      .describe('The statements to record.'),
  },
  output: {
    results: z.array(resultSchema),
    recorded_count: z.number().describe('Always 0 for a preview.'),
  },
  async handler({ statements }, ctx) {
    const lookups = createLookups(ctx);
    const { toMinor, toMajor, format } = ctx.amounts;
    const accountNames = new Map(
      (await ctx.api.getAccounts()).map(a => [a.id, a.name] as const),
    );
    const results: z.output<typeof resultSchema>[] = [];

    for (const statement of statements) {
      const base = {
        account: statement.account,
        due_date: statement.due_date,
        updates_existing: false,
        pay_from: null,
        payment_amount: null,
        regular_schedule: null,
        warning: null,
        paid: null,
        reason: null,
      };
      try {
        const account = await lookups.account(statement.account);
        const payFrom = statement.pay_from
          ? await lookups.account(statement.pay_from)
          : null;
        const input = {
          account: account.id,
          due_date: statement.due_date,
          statement_balance: toMinor(statement.statement_balance),
          closing_date: statement.closing_date ?? null,
          minimum_due:
            statement.minimum_due == null
              ? null
              : toMinor(statement.minimum_due),
          payment_amount:
            statement.payment_amount == null
              ? null
              : toMinor(statement.payment_amount),
          pay_from: payFrom?.id ?? null,
        };
        const plan = await ctx.lootCore.send('card-statement/plan', input);
        const conflict = plan.regularConflict
          ? `The card's regular payment "${plan.regular?.name ?? ''}" is next due ${plan.regularConflict.nextDate}, before this statement, so it was left alone and its payment near ${statement.due_date} will also count until that earlier payment is in. Record the earlier statement first.`
          : null;
        const row = {
          ...base,
          account: account.name,
          updates_existing: plan.existing !== null,
          pay_from: accountNames.get(plan.payFrom) ?? plan.payFrom,
          payment_amount: toMajor(plan.paymentAmount),
          regular_schedule: plan.regular
            ? {
                name: plan.regular.name,
                next_date: plan.regular.nextDate,
                skipped: plan.skipsRegular,
              }
            : null,
          warning: conflict,
        };
        if (ctx.dryRun) {
          results.push({ ...row, status: 'ready' });
          continue;
        }
        const recorded = await ctx.lootCore.send(
          'card-statement/record',
          input,
        );
        results.push({ ...row, status: 'recorded', paid: recorded.paid });
      } catch (error) {
        if (!(isToolError(error) || error instanceof Error)) throw error;
        results.push({
          ...base,
          status: 'skipped',
          reason: (error as Error).message,
        });
      }
    }

    const recorded = results.filter(r => r.status === 'recorded').length;
    const lines = results.map(result => {
      if (result.status === 'skipped') {
        return `[SKIPPED] ${result.account} due ${result.due_date}: ${result.reason}`;
      }
      const tag = result.status === 'recorded' ? 'RECORDED' : 'ready';
      const regular = result.regular_schedule
        ? result.regular_schedule.skipped
          ? `; moves "${result.regular_schedule.name ?? ''}" past it`
          : `; "${result.regular_schedule.name ?? ''}" left alone`
        : '';
      const paid = result.paid ? ' (already paid)' : '';
      return `[${tag}] ${result.account}: pays ${format(result.payment_amount ?? 0)} from ${result.pay_from} on ${result.due_date}${result.updates_existing ? ', correcting the statement recorded before' : ''}${regular}${paid}${result.warning ? `\n    Warning: ${result.warning}` : ''}`;
    });
    const header = ctx.dryRun
      ? `Would record ${results.filter(r => r.status === 'ready').length} of ${results.length} statement(s).`
      : `Recorded ${recorded} of ${results.length} statement(s).`;
    return {
      data: { results, recorded_count: recorded },
      text: [header, ...lines].join('\n'),
    };
  },
});
