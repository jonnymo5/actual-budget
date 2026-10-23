import type { ActualContext } from './session';

export type CategorySummary = {
  id: string;
  name: string;
  hidden: boolean;
};

export type CategoryGroupSummary = {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  categories: CategorySummary[];
};

/**
 * Category groups in budget order, each with its categories. Hidden groups and
 * categories are left out unless asked for.
 */
export async function getCategoryGroups(
  ctx: ActualContext,
  { includeHidden }: { includeHidden: boolean },
): Promise<CategoryGroupSummary[]> {
  // Without a `hidden` option the API returns everything; `hidden: false`
  // drops hidden groups and the hidden categories inside visible groups.
  const groups = await ctx.api.getCategoryGroups(
    includeHidden ? undefined : { hidden: false },
  );

  return groups.map(group => ({
    id: group.id,
    name: group.name,
    is_income: Boolean(group.is_income),
    hidden: Boolean(group.hidden),
    categories: (group.categories ?? []).map(category => ({
      id: category.id,
      name: category.name,
      hidden: Boolean(category.hidden),
    })),
  }));
}
