import { cashFlowProjection } from './analysis/cash-flow-projection';
import { detectRecurringTool } from './analysis/detect-recurring';
import { findOutliersTool } from './analysis/find-outliers';
import { monthComparison } from './analysis/month-comparison';
import { spendingSummary } from './analysis/spending-summary';
import { spendingTrends } from './analysis/spending-trends';
import { getBudgetMonth } from './query/get-budget-month';
import { getBudgetMonths } from './query/get-budget-months';
import { getCategories } from './query/get-categories';
import { getOverview } from './query/get-overview';
import { getPayees } from './query/get-payees';
import { getRules } from './query/get-rules';
import { getSchedules } from './query/get-schedules';
import { getTransactions } from './query/get-transactions';
import { listAccounts } from './query/list-accounts';
import { runQuery } from './query/run-query';
import type { ToolDefinition } from './registry';

/** Every tool the server can offer; the registry decides which to expose. */
export const allTools: ToolDefinition[] = [
  getOverview,
  listAccounts,
  getTransactions,
  getCategories,
  getPayees,
  getBudgetMonths,
  getBudgetMonth,
  getSchedules,
  getRules,
  runQuery,
  spendingSummary,
  spendingTrends,
  findOutliersTool,
  detectRecurringTool,
  cashFlowProjection,
  monthComparison,
];
