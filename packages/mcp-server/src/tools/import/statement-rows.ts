import { z } from 'zod';

import { isoDate } from '#tools/schemas';

/** As many statement lines as one call takes; more than a month or two of a busy account. */
export const MAX_STATEMENT_ROWS = 1000;

/**
 * One line of a bank statement. It matches what parse_ofx returns, so those
 * rows can be passed on as they are.
 */
export const statementRowSchema = z.object({
  date: isoDate.describe('The day the transaction posted, YYYY-MM-DD.'),
  amount: z
    .number()
    .describe(
      'Major currency units (e.g. dollars, not cents), signed: money out (a purchase, a fee) is negative and money in (a deposit, a refund) is positive.',
    ),
  payee_name: z
    .string()
    .nullish()
    .describe(
      'Who was paid or paid you, as it should appear in the budget. An existing payee with this name (case-insensitive) is reused; otherwise one is created.',
    ),
  notes: z.string().nullish().describe('Free text kept on the transaction.'),
  imported_id: z
    .string()
    .nullish()
    .describe(
      "The bank's own id for the transaction (OFX FITID). It is how a second import of the same statement recognises transactions it already has. Must be unique within one call. Leave it out when the statement has no such id.",
    ),
  category: z
    .string()
    .nullish()
    .describe(
      'A category name (case-insensitive) or id. Leave it out to let the budget rules decide; a rule that matches overrides it.',
    ),
});

export const statementRowsSchema = z
  .array(statementRowSchema)
  .min(1)
  .max(MAX_STATEMENT_ROWS);

/** The count of rows that may be listed in a result before the rest are summarized. */
export const MAX_LISTED_ROWS = 20;
