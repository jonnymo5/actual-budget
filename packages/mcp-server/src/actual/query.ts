import { z } from 'zod';

import type { ActualApi, ActualContext } from './session';

export type AqlQuery = ReturnType<ActualApi['q']>;

const resultSchema = z.object({ data: z.array(z.unknown()) });

/**
 * Runs an ActualQL query and validates every row against `rowSchema`, so the
 * rest of the code works with typed rows instead of whatever the engine sent.
 */
export async function queryRows<Row extends z.ZodType>(
  ctx: ActualContext,
  query: AqlQuery,
  rowSchema: Row,
): Promise<z.output<Row>[]> {
  const result = resultSchema.parse(await ctx.api.aqlQuery(query));
  return z.array(rowSchema).parse(result.data);
}
