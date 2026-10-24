import { ofx2json } from '@actual-app/core/server/transactions/import/ofx2json';
import { z } from 'zod';

import { toolError } from '#errors';

import { isValidIsoDate } from './amounts';

/** One statement line, in the shape `import_transactions` takes. */
export type OfxRow = {
  /** YYYY-MM-DD. */
  date: string;
  /** Major units, signed: money out is negative. */
  amount: number;
  payee_name: string | null;
  notes: string | null;
  /** The bank's FITID. */
  imported_id: string | null;
};

export type SkippedOfxEntry = {
  /** Where the entry stands in the file, counting from 1. */
  position: number;
  imported_id: string | null;
  reason: string;
};

export type ParsedOfx = {
  rows: OfxRow[];
  skipped: SkippedOfxEntry[];
  warnings: string[];
};

// ofx2json is written for loose input and types every field as a string, but
// a tag a bank left out comes back undefined.
const entrySchema = z.object({
  amount: z.string().nullish(),
  fitId: z.string().nullish(),
  name: z.string().nullish(),
  memo: z.string().nullish(),
  date: z.string().nullish(),
});

// A plain decimal, with commas allowed only as thousands separators. A comma
// used as the decimal mark ("12,34") is refused rather than guessed at: reading
// it as 1234 would be wrong by a factor of 100.
const PLAIN_AMOUNT = /^[+-]?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;

function parseAmount(
  text: string | null | undefined,
  decimalPlaces: number,
): { amount: number } | { problem: string } {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return { problem: 'it has no amount' };
  if (!PLAIN_AMOUNT.test(trimmed)) {
    return {
      problem: `the amount "${trimmed}" is not a plain number such as -12.34`,
    };
  }
  const amount = Number(trimmed.replace(/,/g, ''));
  const scaled = amount * 10 ** decimalPlaces;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return {
      problem: `the amount ${trimmed} has more than ${decimalPlaces} decimal places`,
    };
  }
  return { amount: Number(amount.toFixed(decimalPlaces)) };
}

function clean(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the transactions out of an OFX or QFX statement. Anything it cannot
 * read exactly is listed in `skipped` instead of being guessed at, so that no
 * amount is ever silently wrong.
 */
export async function parseOfxStatement(
  content: string,
  { decimalPlaces }: { decimalPlaces: number },
): Promise<ParsedOfx> {
  if (!/<OFX[\s>]/i.test(content)) {
    throw toolError(
      'this does not look like an OFX or QFX file: it has no <OFX> element. Pass the whole text of the file, headers included.',
    );
  }

  let entries: unknown[];
  try {
    entries = (await ofx2json(content)).transactions;
  } catch (error) {
    throw toolError(
      `could not read the file as OFX/QFX (${describeFailure(error)}). Pass the whole text of the file, unchanged.`,
    );
  }

  const rows: OfxRow[] = [];
  const skipped: SkippedOfxEntry[] = [];
  entries.forEach((raw, index) => {
    const entry = entrySchema.parse(raw);
    const importedId = clean(entry.fitId);
    const skip = (reason: string) =>
      skipped.push({
        position: index + 1,
        imported_id: importedId,
        reason,
      });

    const date = entry.date ?? '';
    if (!isValidIsoDate(date)) {
      skip(`its date "${date}" is not a real date`);
      return;
    }
    const parsed = parseAmount(entry.amount, decimalPlaces);
    if ('problem' in parsed) {
      skip(parsed.problem);
      return;
    }

    // Banks differ in which of NAME and MEMO holds the description. Use NAME as
    // the payee and keep a different MEMO as notes; when there is no NAME, the
    // MEMO is the only description there is.
    const name = clean(entry.name)?.replace(/\s+/g, ' ') ?? null;
    const memo = clean(entry.memo);
    rows.push({
      date,
      amount: parsed.amount,
      payee_name: name ?? memo?.replace(/\s+/g, ' ') ?? null,
      notes:
        name && memo && memo.toLowerCase() !== name.toLowerCase() ? memo : null,
      imported_id: importedId,
    });
  });

  const warnings: string[] = [];
  if (entries.length === 0) {
    warnings.push('The file has no transactions.');
  }
  const statements =
    content.match(/<(STMTRS|CCSTMTRS|INVSTMTRS)>/gi)?.length ?? 0;
  if (statements > 1) {
    warnings.push(
      `The file holds ${statements} account statements and the rows of all of them are combined here. Import each account's rows into that account only.`,
    );
  }
  const seen = new Map<string, number>();
  for (const { imported_id } of rows) {
    if (imported_id) seen.set(imported_id, (seen.get(imported_id) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, count]) => count > 1);
  if (repeated.length > 0) {
    warnings.push(
      `${repeated.length} FITID value(s) appear more than once (for example ${repeated[0][0]}). import_transactions needs every imported_id to be unique, so make them unique or leave imported_id out for those rows.`,
    );
  }
  if (skipped.length > 0) {
    warnings.push(
      `${skipped.length} entr${skipped.length === 1 ? 'y was' : 'ies were'} left out because they could not be read exactly; see skipped.`,
    );
  }

  return { rows, skipped, warnings };
}
