import { z } from 'zod';

import { getAccountsWithBalances } from './accounts';
import type { AccountSummary, AccountsWithBalances } from './accounts';
import { todayIso } from './amounts';
import { queryRows } from './query';
import type { ActualContext } from './session';

export type CategoryGroupSummary = {
  name: string;
  is_income: boolean;
  hidden: boolean;
  categories: string[];
};

export type Overview = {
  budget_name: string;
  /** Today's date on the machine running the server, `YYYY-MM-DD`. */
  today: string;
  decimal_places: number;
  server_version: string | null;
  sync: { last_synced_at: string | null; last_error: string | null };
  accounts: AccountSummary[];
  closed_account_count: number;
  totals: AccountsWithBalances['totals'];
  transactions: {
    count: number;
    first_date: string | null;
    last_date: string | null;
  };
  category_groups: CategoryGroupSummary[];
};

const dateRowSchema = z.object({ date: z.string() });
const countRowSchema = z.object({ count: z.number() });

async function getTransactionRange(ctx: ActualContext) {
  const { q } = ctx.api;
  const [counted] = await queryRows(
    ctx,
    q('transactions').select([{ count: { $count: '$id' } }]),
    countRowSchema,
  );
  const [first] = await queryRows(
    ctx,
    q('transactions').select('date').orderBy('date').limit(1),
    dateRowSchema,
  );
  const [last] = await queryRows(
    ctx,
    q('transactions').select('date').orderBy({ date: 'desc' }).limit(1),
    dateRowSchema,
  );

  return {
    count: counted?.count ?? 0,
    first_date: first?.date ?? null,
    last_date: last?.date ?? null,
  };
}

async function getServerVersion(ctx: ActualContext): Promise<string | null> {
  const result = await ctx.api.getServerVersion();
  return 'version' in result ? result.version : null;
}

export async function buildOverview(ctx: ActualContext): Promise<Overview> {
  const { accounts, totals } = await getAccountsWithBalances(ctx, {
    includeClosed: true,
  });
  const openAccounts = accounts.filter(account => !account.closed);
  const groups = await ctx.api.getCategoryGroups();
  const syncStatus = ctx.syncStatus();

  return {
    budget_name: ctx.budget.name,
    today: todayIso(),
    decimal_places: ctx.amounts.decimalPlaces,
    server_version: await getServerVersion(ctx),
    sync: {
      last_synced_at: syncStatus.lastSyncedAt
        ? new Date(syncStatus.lastSyncedAt).toISOString()
        : null,
      last_error: syncStatus.lastError,
    },
    accounts: openAccounts,
    closed_account_count: accounts.length - openAccounts.length,
    totals,
    transactions: await getTransactionRange(ctx),
    category_groups: groups.map(group => ({
      name: group.name,
      is_income: Boolean(group.is_income),
      hidden: Boolean(group.hidden),
      categories: (group.categories ?? []).map(category => category.name),
    })),
  };
}
