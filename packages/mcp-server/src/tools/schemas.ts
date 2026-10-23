import { z } from 'zod';

import { isValidIsoDate } from '#actual/amounts';

/** A calendar date as `YYYY-MM-DD`, validated for real. Add `.describe()` at use. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'must be formatted YYYY-MM-DD' })
  .refine(isValidIsoDate, { error: 'is not a real calendar date' });
