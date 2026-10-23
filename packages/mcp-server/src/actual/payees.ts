import type { ActualContext } from './session';

export type PayeeSummary = {
  id: string;
  name: string;
  /** Transfers between accounts are recorded against a payee per account. */
  is_transfer: boolean;
  transfer_account_id: string | null;
};

export type PayeePage = {
  payees: PayeeSummary[];
  /** How many payees match, across all pages. */
  total_count: number;
  offset: number;
  has_more: boolean;
};

export async function searchPayees(
  ctx: ActualContext,
  {
    search,
    limit,
    offset,
  }: { search: string | undefined; limit: number; offset: number },
): Promise<PayeePage> {
  const needle = search?.trim().toLowerCase();
  const matching = (await ctx.api.getPayees())
    .filter(payee => !needle || payee.name.toLowerCase().includes(needle))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );

  const page = matching.slice(offset, offset + limit);
  return {
    payees: page.map(payee => ({
      id: payee.id,
      name: payee.name,
      is_transfer: Boolean(payee.transfer_acct),
      transfer_account_id: payee.transfer_acct ?? null,
    })),
    total_count: matching.length,
    offset,
    has_more: offset + page.length < matching.length,
  };
}
