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
