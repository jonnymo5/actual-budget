import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Session } from '#actual/session';
import { allTools } from '#tools/index';
import { registerTools } from '#tools/registry';
import type { ToolDefinition } from '#tools/registry';
import pkg from '../package.json';

const INSTRUCTIONS = [
  'This server exposes one Actual Budget. Call get_overview first: it lists the accounts, the category names, how far back the data goes, and what today is.',
  'Amounts are in major currency units (dollars, not cents). Spending is negative and income is positive. Dates are YYYY-MM-DD.',
  'Tools that change data are dry-run by default: they return a preview and change nothing until called again with dry_run false.',
  "Money moved between the budget's own accounts is a transfer, not income or spending. If card payments or moves between accounts show up as income or uncategorized spending, find_transfer_candidates lists the ones that are not linked yet and link_transfers links them; ask the person before linking any pair it marks as needing confirmation.",
].join('\n');

type CreateServerOptions = {
  session: Session;
  readOnly: boolean;
  tools?: ToolDefinition[];
  log?: (message: string) => void;
};

export function createServer({
  session,
  readOnly,
  tools = allTools,
  log,
}: CreateServerOptions) {
  const server = new McpServer(
    { name: 'actual-budget', version: pkg.version },
    { instructions: INSTRUCTIONS },
  );
  const toolNames = registerTools(server, tools, { session, readOnly, log });
  return { server, toolNames };
}
