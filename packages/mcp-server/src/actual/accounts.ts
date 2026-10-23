import type { ActualContext } from './session';

export type AccountSummary = {
  id: string;
  name: string;
  /** Current balance in major currency units. */
  balance: number;
  off_budget: boolean;
  closed: boolean;
};

export type AccountsWithBalances = {
  accounts: AccountSummary[];
  totals: { on_budget: number; off_budget: number; all: number };
};

export async function getAccountsWithBalances(
  ctx: ActualContext,
  { includeClosed }: { includeClosed: boolean },
): Promise<AccountsWithBalances> {
  const accounts = await ctx.api.getAccounts();

  const summaries: AccountSummary[] = [];
  // Sum in integer minor units and convert once, so totals carry no float drift.
  const minorTotals = { on_budget: 0, off_budget: 0 };
  for (const account of accounts) {
    if (account.closed && !includeClosed) continue;

    const minor = await ctx.api.getAccountBalance(account.id);
    const offBudget = Boolean(account.offbudget);
    minorTotals[offBudget ? 'off_budget' : 'on_budget'] += minor;
    summaries.push({
      id: account.id,
      name: account.name,
      balance: ctx.amounts.toMajor(minor),
      off_budget: offBudget,
      closed: Boolean(account.closed),
    });
  }

  return {
    accounts: summaries,
    totals: {
      on_budget: ctx.amounts.toMajor(minorTotals.on_budget),
      off_budget: ctx.amounts.toMajor(minorTotals.off_budget),
      all: ctx.amounts.toMajor(minorTotals.on_budget + minorTotals.off_budget),
    },
  };
}
