import { z } from 'zod';

import { addDays } from '#analysis/dates';
import { extraCopiesTotal, findDuplicateGroups } from '#analysis/duplicates';
import type { DuplicateCandidate, DuplicateGroup } from '#analysis/duplicates';

import { queryRows } from './query';
import type { ActualContext } from './session';
import { classifyRows } from './statement-import';
import type { PreparedRow, StatementAccount } from './statement-import';

/** Two entries of one transaction are usually a day or two apart. */
const DUPLICATE_WINDOW_DAYS = 3;

/** How far back to look for double entries when nothing says where the statement starts. */
const DEFAULT_WINDOW_DAYS = 31;

const candidateSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  payee: z.string().nullable(),
  'payee.name': z.string().nullable(),
  imported_id: z.string().nullable(),
  notes: z.string().nullable(),
});

async function loadWindow(
  ctx: ActualContext,
  account: StatementAccount,
  { start, end }: { start: string; end: string },
): Promise<DuplicateCandidate[]> {
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({
        $and: [
          { account: account.id },
          { date: { $gte: start } },
          { date: { $lte: end } },
        ],
      })
      .select([
        'id',
        'date',
        'amount',
        'payee',
        'payee.name',
        'imported_id',
        'notes',
      ])
      .orderBy(['date', 'id']),
    candidateSchema,
  );
  return rows.map(row => ({
    id: row.id,
    date: row.date,
    amount: row.amount,
    payee_id: row.payee,
    payee: row['payee.name'],
    imported_id: row.imported_id,
    notes: row.notes,
  }));
}

export type ReconcileRequest = {
  account: StatementAccount;
  /** Major units, signed the way Actual shows the account. */
  statementBalance: number;
  /** The day the statement's balance is for. */
  date: string;
  /** The first day of the statement; defaults to the first statement row. */
  startDate: string | null;
  /** The statement's own lines, when the caller has them. */
  rows: PreparedRow[] | null;
};

export type ReconcileReport = {
  window: { start_date: string; end_date: string };
  /** All below are integer minor units. */
  actualMinor: number;
  statementMinor: number;
  differenceMinor: number;
  /** Statement rows Actual does not have; null when no rows were given. */
  missing: { rows: PreparedRow[]; totalMinor: number } | null;
  /** Rows dated after the statement, which are left out of the sums. */
  rowsAfterStatement: number;
  duplicateGroups: DuplicateGroup[];
  extraCopiesMinor: number;
};

/**
 * Compares the statement's ending balance with the account's balance on that
 * day, and looks for the two usual causes of a gap: statement lines missing
 * from Actual, and transactions entered twice.
 */
export async function reconcileAccount(
  ctx: ActualContext,
  { account, statementBalance, date, startDate, rows }: ReconcileRequest,
): Promise<ReconcileReport> {
  const [year, month, day] = date.split('-').map(Number);
  // The API takes a Date and reads its calendar day in local time.
  const actualMinor = await ctx.api.getAccountBalance(
    account.id,
    new Date(year, month - 1, day),
  );
  const statementMinor = ctx.amounts.toMinor(statementBalance);

  const dates = rows?.map(row => row.date).sort() ?? [];
  const start = startDate ?? dates[0] ?? addDays(date, -DEFAULT_WINDOW_DAYS);

  let missing: ReconcileReport['missing'] = null;
  let rowsAfterStatement = 0;
  if (rows) {
    const { rows: classified } = await classifyRows(ctx, account, rows);
    const absent = classified
      .filter(entry => entry.status === 'new')
      .map(entry => entry.row);
    const counted = absent.filter(row => row.date <= date);
    rowsAfterStatement = absent.length - counted.length;
    missing = {
      rows: counted,
      totalMinor: counted.reduce((sum, row) => sum + row.minor, 0),
    };
  }

  const duplicateGroups = findDuplicateGroups(
    await loadWindow(ctx, account, { start, end: date }),
    { windowDays: DUPLICATE_WINDOW_DAYS },
  );

  return {
    window: { start_date: start, end_date: date },
    actualMinor,
    statementMinor,
    differenceMinor: statementMinor - actualMinor,
    missing,
    rowsAfterStatement,
    duplicateGroups,
    extraCopiesMinor: extraCopiesTotal(duplicateGroups),
  };
}

/**
 * What the numbers say about the gap, in plain sentences. `format` turns
 * integer minor units into text.
 */
export function explainDifference(
  report: ReconcileReport,
  { date, format }: { date: string; format: (minor: number) => string },
): string[] {
  const { differenceMinor, statementMinor, actualMinor, missing } = report;
  const findings: string[] = [];
  const missingCount = missing?.rows.length ?? 0;

  if (differenceMinor === 0) {
    findings.push(
      `Actual's balance on ${date} matches the statement (${format(actualMinor)}).`,
    );
    if (missing && missingCount > 0) {
      findings.push(
        `Even so, ${missingCount} statement row(s) are not in Actual (net ${format(missing.totalMinor)}), so something else in the account offsets them: look for transactions Actual has that the statement does not.`,
      );
    }
    return findings;
  }

  findings.push(
    `The statement says ${format(statementMinor)} but Actual's balance on ${date} is ${format(actualMinor)}: Actual is ${format(Math.abs(differenceMinor))} ${differenceMinor > 0 ? 'too low' : 'too high'}.`,
  );
  if (
    actualMinor !== 0 &&
    statementMinor !== 0 &&
    statementMinor === -actualMinor
  ) {
    findings.push(
      `The two are exact opposites. Actual shows money you owe as negative, so a credit card or loan statement balance of ${format(Math.abs(statementMinor))} owed should be given as ${format(-Math.abs(statementMinor))}.`,
    );
  }

  let remaining = differenceMinor;
  if (!missing) {
    findings.push(
      'No statement rows were given, so missing transactions cannot be identified. Pass rows (from parse_ofx, or read from the statement) to find them.',
    );
  } else if (missingCount === 0) {
    findings.push(
      'Every statement row is already in Actual, so the gap is not from missing statement rows.',
    );
  } else {
    remaining = differenceMinor - missing.totalMinor;
    findings.push(
      remaining === 0
        ? `The ${missingCount} statement row(s) that are not in Actual add up to exactly the gap (${format(missing.totalMinor)}). Importing them with import_transactions should reconcile the account.`
        : `The ${missingCount} statement row(s) that are not in Actual total ${format(missing.totalMinor)}, which covers only part of the gap and leaves ${format(remaining)}.`,
    );
  }
  if (report.rowsAfterStatement > 0) {
    findings.push(
      `${report.rowsAfterStatement} row(s) not in Actual are dated after ${date}, so they are not counted in the gap.`,
    );
  }

  if (remaining !== 0 && report.duplicateGroups.length > 0) {
    const copies = report.duplicateGroups.reduce(
      (sum, group) => sum + group.transactions.length - 1,
      0,
    );
    findings.push(
      remaining === -report.extraCopiesMinor
        ? `The remaining ${format(remaining)} is exactly the ${copies} possible double entr${copies === 1 ? 'y' : 'ies'} listed (${format(report.extraCopiesMinor)} together). If they are real double entries, deleting the extra copies should reconcile the account.`
        : `${report.duplicateGroups.length} group(s) of possible double entries were found (${copies} extra, ${format(report.extraCopiesMinor)} together), but they do not match the remaining ${format(remaining)}.`,
    );
  } else if (remaining !== 0 && missing) {
    findings.push(
      `${format(remaining)} is still unexplained. Other usual causes: a wrong opening balance, transactions dated before ${report.window.start_date}, an amount keyed wrongly, or a transaction dated on the wrong side of ${date}.`,
    );
  }
  return findings;
}
