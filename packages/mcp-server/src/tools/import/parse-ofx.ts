import { z } from 'zod';

import { parseOfxStatement } from '#actual/ofx';
import { defineTool } from '#tools/registry';

import { MAX_STATEMENT_ROWS } from './statement-rows';

// A statement is rarely more than a few hundred kilobytes; this stops a
// mistaken paste of something enormous.
const MAX_CONTENT_CHARS = 5_000_000;

export const parseOfx = defineTool({
  name: 'parse_ofx',
  title: 'Parse an OFX/QFX statement',
  description: `Reads the text of an OFX or QFX statement file (a bank or credit card download) and returns its transactions as rows ready for import_transactions and reconcile_account. Pass the whole text of the file as content, headers included. Nothing is imported or changed. Each row has date (YYYY-MM-DD), amount (major currency units, e.g. dollars, not cents; signed: money out is negative), payee_name (the file's NAME, or its MEMO when there is no NAME), notes (the MEMO, when it differs from the NAME) and imported_id (the bank's FITID, which lets a re-import recognise transactions it already has). Entries whose date or amount cannot be read exactly are listed in skipped, never guessed at. Look the rows over before importing: tidy payee names (for example drop store numbers) if you wish, but pass imported_id on unchanged. At most ${MAX_STATEMENT_ROWS} rows can be imported per call.`,
  kind: 'read',
  input: {
    content: z
      .string()
      .min(1)
      .max(MAX_CONTENT_CHARS)
      .describe('The full text of the .ofx or .qfx file.'),
  },
  output: {
    count: z.number().describe('How many rows were read.'),
    rows: z.array(
      z.object({
        date: z.string().describe('YYYY-MM-DD.'),
        amount: z.number().describe('Major units, signed.'),
        payee_name: z.string().nullable(),
        notes: z.string().nullable(),
        imported_id: z.string().nullable(),
      }),
    ),
    first_date: z.string().nullable().describe('YYYY-MM-DD of the oldest row.'),
    last_date: z.string().nullable().describe('YYYY-MM-DD of the newest row.'),
    total_amount: z
      .number()
      .describe('Net sum of all rows, major units, signed.'),
    skipped: z
      .array(
        z.object({
          position: z
            .number()
            .describe('Where the entry stands in the file, counting from 1.'),
          imported_id: z.string().nullable(),
          reason: z.string(),
        }),
      )
      .describe('Entries left out because they could not be read exactly.'),
    warnings: z.array(z.string()),
  },
  async handler({ content }, ctx) {
    const { toMinor, toMajor, format } = ctx.amounts;
    const parsed = await parseOfxStatement(content, {
      decimalPlaces: ctx.amounts.decimalPlaces,
    });

    const dates = parsed.rows.map(row => row.date).sort();
    const warnings = [...parsed.warnings];
    if (parsed.rows.length > MAX_STATEMENT_ROWS) {
      warnings.push(
        `There are more than ${MAX_STATEMENT_ROWS} rows, which is the most import_transactions takes in one call; import them in batches by date.`,
      );
    }
    const data = {
      count: parsed.rows.length,
      rows: parsed.rows,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      total_amount: toMajor(
        parsed.rows.reduce((sum, row) => sum + toMinor(row.amount), 0),
      ),
      skipped: parsed.skipped,
      warnings,
    };

    const lines = [
      parsed.rows.length === 0
        ? 'Read 0 transactions.'
        : `Read ${data.count} transaction(s) dated ${data.first_date} to ${data.last_date}, net ${format(data.total_amount)}. Columns: date | amount | payee_name | notes | imported_id`,
      ...parsed.rows.map(
        row =>
          `${row.date} | ${format(row.amount)} | ${row.payee_name ?? ''} | ${row.notes ?? ''} | ${row.imported_id ?? ''}`,
      ),
      ...parsed.skipped.map(
        entry =>
          `Skipped entry ${entry.position}${entry.imported_id ? ` (${entry.imported_id})` : ''}: ${entry.reason}.`,
      ),
      ...warnings,
    ];
    return { data, text: lines.join('\n') };
  },
});
