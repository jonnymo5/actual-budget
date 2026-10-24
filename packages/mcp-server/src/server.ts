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
