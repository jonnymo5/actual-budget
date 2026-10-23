import { z } from 'zod';

import { toolError } from '#errors';

import { queryRows } from './query';
import type { AqlQuery } from './query';
import type { ActualContext } from './session';
import { readTransactionPage } from './transactions';
import type { TransactionRow } from './transactions';

export type RuleMatchSpec = {
  /** Conditions in the rule engine's format: ids, amounts in minor units. */
  conditions: unknown[];
  /** "all": every condition must match; "any": one is enough. */
  match: 'all' | 'any';
  /** Only transactions on or after this day, `YYYY-MM-DD`. */
  startDate?: string;
  endDate?: string;
};

export type CategoryCount = {
  category_id: string | null;
  category: string | null;
  count: number;
  /** Major units. */
  total_amount: number;
};

export type RuleMatches = {
  total_count: number;
  /** Net sum of every match, major units. */
  total_amount: number;
  /** How the matches are categorised today, most common first. */
  by_category: CategoryCount[];
  /** The newest matches. */
  transactions: TransactionRow[];
  has_more: boolean;
};

const filtersSchema = z.object({
  filters: z.array(z.unknown()),
  errors: z.array(z.string()).default([]),
});

const categoryGroupSchema = z.object({
  category: z.string().nullable(),
  count: z.number(),
  total: z.number().nullable(),
});

const unsearchable = new WeakSet<Error>();

// Fields the rule engine knows only while a transaction is being imported
// cannot be looked up afterwards.
export async function lookUpMatches<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const field = /Field "([^"]+)" does not exist/.exec(message);
    if (field) {
      const refusal = toolError(
        `this rule uses the field "${field[1]}", which cannot be looked up on existing transactions, so its matches cannot be previewed or applied.`,
      );
      unsearchable.add(refusal);
      throw refusal;
    }
    throw error;
  }
}

/**
 * The transactions a rule's conditions match, built by Actual's own filter
 * builder, so they are the same ones the rule editor lists. Split lines are
 * read inline: each is a row and the parent is left out.
 */
export async function buildMatchQuery(
  ctx: ActualContext,
  { conditions, match, startDate, endDate }: RuleMatchSpec,
): Promise<AqlQuery> {
  const { filters, errors } = filtersSchema.parse(
    await ctx.lootCore.send('make-filters-from-conditions', { conditions }),
  );
  if (errors.length > 0 || filters.length === 0) {
    throw toolError(
      `Actual could not turn these conditions into a search${errors.length > 0 ? ` (${errors.join(', ')})` : ''}.`,
    );
  }

  return ctx.api.q('transactions').filter({
    $and: [
      { [match === 'any' ? '$or' : '$and']: filters },
      startDate && { date: { $gte: startDate } },
      endDate && { date: { $lte: endDate } },
    ],
  });
}

/** How many transactions match, how they are categorised, and the newest few. */
export async function previewMatches(
  ctx: ActualContext,
  spec: RuleMatchSpec,
  { limit }: { limit: number },
): Promise<RuleMatches> {
  const matching = await buildMatchQuery(ctx, spec);
  const page = await lookUpMatches(() =>
    readTransactionPage(ctx, matching, { limit, offset: 0 }),
  );
  const groups = await lookUpMatches(() =>
    queryRows(
      ctx,
      matching
        .groupBy('category')
        .select([
          'category',
          { count: { $count: '$id' } },
          { total: { $sum: '$amount' } },
        ]),
      categoryGroupSchema,
    ),
  );

  const names = new Map(
    (await ctx.api.getCategories()).map(category => [
      category.id,
      category.name,
    ]),
  );
  const byCategory = groups
    .map(group => ({
      category_id: group.category,
      category:
        group.category === null ? null : (names.get(group.category) ?? null),
      count: group.count,
      total_amount: ctx.amounts.toMajor(group.total ?? 0),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total_count: page.total_count,
    total_amount: page.total_amount,
    by_category: byCategory,
    transactions: page.transactions,
    has_more: page.has_more,
  };
}

/**
 * Like `previewMatches`, but null when the conditions use something that cannot
 * be looked up. A rule made in Actual's own screens can; changing or deleting
 * it should still work, just without a preview.
 */
export async function previewMatchesIfPossible(
  ctx: ActualContext,
  spec: RuleMatchSpec,
  options: { limit: number },
): Promise<RuleMatches | null> {
  try {
    return await previewMatches(ctx, spec, options);
  } catch (error) {
    if (error instanceof Error && unsearchable.has(error)) return null;
    throw error;
  }
}
