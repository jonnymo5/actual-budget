import { getOverview } from './query/get-overview';
import { getTransactions } from './query/get-transactions';
import { listAccounts } from './query/list-accounts';
import type { ToolDefinition } from './registry';

/** Every tool the server can offer; the registry decides which to expose. */
export const allTools: ToolDefinition[] = [
  getOverview,
  listAccounts,
  getTransactions,
];
