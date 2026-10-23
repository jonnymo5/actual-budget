import { z } from 'zod';

import { isValidIsoDate, isValidIsoMonth } from '#actual/amounts';

/** A calendar date as `YYYY-MM-DD`, validated for real. Add `.describe()` at use. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'must be formatted YYYY-MM-DD' })
  .refine(isValidIsoDate, { error: 'is not a real calendar date' });

/** A budget month as `YYYY-MM`. Add `.describe()` at use. */
export const isoMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/, { error: 'must be formatted YYYY-MM' })
  .refine(isValidIsoMonth, { error: 'is not a real month' });

/** One field a tool changed (or would change) on a transaction. */
export const fieldChangeSchema = z.object({
  field: z.enum(['category', 'payee', 'notes']),
  from: z.string().nullable().describe('The value now; null when it is empty.'),
  to: z.string().nullable().describe('The value after the change.'),
});

/** A transaction a tool changed (or would change), with what happens to it. */
export const editSampleSchema = z.object({
  id: z.string(),
  date: z.string().describe('YYYY-MM-DD.'),
  amount: z.number().describe('Major units, signed: spending is negative.'),
  account: z.string().nullable(),
  payee: z.string().nullable(),
  changes: z.array(fieldChangeSchema),
});

/** Money moving into one category. */
export const categoryTotalSchema = z.object({
  category_id: z.string(),
  category: z.string(),
  count: z.number(),
  total_amount: z
    .number()
    .describe('Net sum of those transactions, major units, signed.'),
});
