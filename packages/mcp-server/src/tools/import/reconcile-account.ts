import { z } from 'zod';

import { explainDifference, reconcileAccount } from '#actual/reconcile';
import { loadStatementAccount, prepareRows } from '#actual/statement-import';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

import { MAX_LISTED_ROWS, statementRowsSchema } from './statement-rows';

export const reconcileAccountTool = defineTool({
  name: 'reconcile_account',
  title: 'Reconcile an account with a statement',
  description: `Checks an account against a bank statement without changing anything. Give the statement's ending balance (statement_balance, major currency units, e.g. dollars, not cents) and the day it is for (statement_date, YYYY-MM-DD). The result compares it with Actual's balance for the account on that day and says how far apart they are. Sign matters: Actual shows money you owe, such as a credit card balance, as negative. Pass the statement's own lines as rows (the same shape as import_transactions; parse_ofx returns them) and the result also lists the rows Actual does not have, which are the usual reason for a gap, and whether they add up to exactly the gap. Whether or not rows are given, it lists possible double entries in the account (the same payee and amount within 3 days; two real purchases can look the same) between statement_start_date and statement_date, and says whether they explain what is left. To fix what it finds: import_transactions adds the missing rows, and delete a real double entry in Actual itself. Dates are YYYY-MM-DD.`,
  kind: 'read',
  input: {
    account_id: z
      .string()
      .min(1)
      .describe('The account: an id from list_accounts, or its exact name.'),
    statement_balance: z
      .number()
      .describe(
        "The statement's ending balance, major units, signed the way Actual shows the account: negative when you owe money.",
      ),
    statement_date: isoDate.describe(
      'The day the ending balance is for (the last day of the statement), YYYY-MM-DD. Transactions up to and including it are counted.',
    ),
    statement_start_date: isoDate
      .optional()
      .describe(
        'The first day of the statement, YYYY-MM-DD. Sets how far back possible double entries are looked for. Defaults to the oldest row, or 31 days before statement_date when there are no rows.',
      ),
    rows: statementRowsSchema
      .optional()
      .describe(
        "The statement's lines, to find the ones Actual is missing. Optional.",
      ),
  },
  output: {
    account: z.object({ id: z.string(), name: z.string() }),
    statement_date: z.string().describe('YYYY-MM-DD.'),
    actual_balance: z
      .number()
      .describe("Actual's balance on statement_date, major units, signed."),
    statement_balance: z.number().describe('Major units, signed.'),
    difference: z
      .number()
      .describe(
        'Statement minus Actual, major units. Positive: Actual is too low.',
      ),
    balanced: z.boolean().describe('True when the difference is zero.'),
    window: z.object({
      start_date: z.string().describe('YYYY-MM-DD.'),
      end_date: z.string().describe('YYYY-MM-DD.'),
    }),
    missing_from_actual: z
      .object({
        count: z.number(),
        total_amount: z.number().describe('Major units, signed.'),
        rows: z.array(
          z.object({
            row: z
              .number()
              .describe('The row, counting from 1 in the rows you sent.'),
            date: z.string().describe('YYYY-MM-DD.'),
            amount: z.number().describe('Major units, signed.'),
            payee_name: z.string().nullable(),
            imported_id: z.string().nullable(),
          }),
        ),
      })
      .nullable()
      .describe(
        `Statement rows dated up to statement_date that Actual does not have (the first ${MAX_LISTED_ROWS} listed); null when no rows were given.`,
      ),
    difference_after_missing: z
      .number()
      .nullable()
      .describe(
        'The difference once the missing rows are counted in, major units; null when no rows were given. Zero means they explain it.',
      ),
    possible_duplicates: z.object({
      group_count: z.number(),
      extra_copies_total: z
        .number()
        .describe(
          'What the copies beyond the first in each group add up to, major units, signed.',
        ),
      groups: z.array(
        z.object({
          payee: z.string().nullable(),
          amount: z
            .number()
            .describe('Each transaction in the group, major units, signed.'),
          transactions: z.array(
            z.object({
              id: z.string(),
              date: z.string().describe('YYYY-MM-DD.'),
              notes: z.string().nullable(),
              has_imported_id: z.boolean(),
            }),
          ),
        }),
      ),
    }),
    findings: z
      .array(z.string())
      .describe('What the numbers say, in plain words.'),
  },
  async handler(
    {
      account_id,
      statement_balance,
      statement_date,
      statement_start_date,
      rows,
    },
    ctx,
  ) {
    if (statement_start_date && statement_start_date > statement_date) {
      throw toolError(
        'statement_start_date is after statement_date; the statement cannot start after it ends.',
      );
    }
    const { toMajor, format } = ctx.amounts;
    const account = await loadStatementAccount(ctx, account_id, {
      allowClosed: true,
    });
    const prepared = rows ? await prepareRows(ctx, account, rows) : null;
    const report = await reconcileAccount(ctx, {
      account,
      statementBalance: statement_balance,
      date: statement_date,
      startDate: statement_start_date ?? null,
      rows: prepared,
    });
    const findings = explainDifference(report, {
      date: statement_date,
      format: minor => format(toMajor(minor)),
    });

    const data = {
      account: { id: account.id, name: account.name },
      statement_date,
      actual_balance: toMajor(report.actualMinor),
      statement_balance: toMajor(report.statementMinor),
      difference: toMajor(report.differenceMinor),
      balanced: report.differenceMinor === 0,
      window: report.window,
      missing_from_actual: report.missing && {
        count: report.missing.rows.length,
        total_amount: toMajor(report.missing.totalMinor),
        rows: report.missing.rows.slice(0, MAX_LISTED_ROWS).map(row => ({
          row: row.position,
          date: row.date,
          amount: row.amount,
          payee_name: row.payee_name,
          imported_id: row.imported_id,
        })),
      },
      difference_after_missing: report.missing
        ? toMajor(report.differenceMinor - report.missing.totalMinor)
        : null,
      possible_duplicates: {
        group_count: report.duplicateGroups.length,
        extra_copies_total: toMajor(report.extraCopiesMinor),
        groups: report.duplicateGroups.slice(0, MAX_LISTED_ROWS).map(group => ({
          payee: group.payee,
          amount: toMajor(group.amount),
          transactions: group.transactions.map(transaction => ({
            id: transaction.id,
            date: transaction.date,
            notes: transaction.notes,
            has_imported_id: transaction.imported_id !== null,
          })),
        })),
      },
      findings,
    };

    const lines = [
      `${account.name} on ${statement_date}: statement ${format(data.statement_balance)}, Actual ${format(data.actual_balance)}, difference ${format(data.difference)}${data.balanced ? ' (balanced)' : ''}.`,
      ...findings.map(finding => `- ${finding}`),
    ];
    const missing = data.missing_from_actual;
    if (missing && missing.count > 0) {
      lines.push('Statement rows not in Actual:');
      lines.push(
        ...missing.rows.map(
          row =>
            `  row ${row.row} | ${row.date} | ${format(row.amount)} | ${row.payee_name ?? '(no payee)'}`,
        ),
      );
      if (missing.count > missing.rows.length) {
        lines.push(`  ... and ${missing.count - missing.rows.length} more.`);
      }
    }
    if (data.possible_duplicates.group_count > 0) {
      lines.push('Possible double entries:');
      for (const group of data.possible_duplicates.groups) {
        lines.push(
          `  ${group.payee ?? '(no payee)'} ${format(group.amount)}: ${group.transactions.map(transaction => `${transaction.date} [id: ${transaction.id}]`).join(', ')}`,
        );
      }
    }
    return { data, text: lines.join('\n') };
  },
});
