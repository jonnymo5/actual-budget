import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

let budget: TestBudget;

beforeAll(async () => {
  budget = await createTestBudget();
});

afterAll(async () => {
  await budget.dispose();
});

// Every tool the server offers today. Adding a tool means adding it to one of
// these two lists, and to the lists below, so its description is held to the
// same standard.
const READ_TOOLS = [
  'cash_flow_projection',
  'detect_recurring',
  'find_outliers',
  'get_budget_month',
  'get_budget_months',
  'get_categories',
  'get_overview',
  'get_payees',
  'get_rules',
  'get_schedules',
  'get_transactions',
  'get_uncategorized',
  'list_accounts',
  'month_comparison',
  'preview_rule',
  'run_query',
  'spending_summary',
  'spending_trends',
];

// Tools that can change the budget. They are dry-run by default, and absent in
// read-only mode.
const WRITE_TOOLS = [
  'apply_rules_retroactively',
  'categorize_transactions',
  'create_rule',
  'delete_rule',
  'update_rule',
  'update_transaction',
];

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS].sort();

// Tools whose results include money must say it is in major units.
const REPORT_MONEY = [
  'apply_rules_retroactively',
  'cash_flow_projection',
  'categorize_transactions',
  'create_rule',
  'delete_rule',
  'detect_recurring',
  'find_outliers',
  'get_budget_month',
  'get_overview',
  'get_rules',
  'get_schedules',
  'get_transactions',
  'get_uncategorized',
  'list_accounts',
  'month_comparison',
  'preview_rule',
  'run_query',
  'spending_summary',
  'spending_trends',
  'update_rule',
  'update_transaction',
];

// Tools that take or return dates must say how they are written.
const REPORT_DATES: Record<string, RegExp> = {
  apply_rules_retroactively: /YYYY-MM-DD/,
  cash_flow_projection: /YYYY-MM-DD/,
  create_rule: /YYYY-MM-DD/,
  delete_rule: /YYYY-MM-DD/,
  detect_recurring: /YYYY-MM-DD/,
  find_outliers: /YYYY-MM-DD/,
  get_budget_month: /YYYY-MM/,
  get_budget_months: /YYYY-MM/,
  get_overview: /YYYY-MM-DD/,
  get_rules: /YYYY-MM-DD/,
  get_schedules: /YYYY-MM-DD/,
  get_transactions: /YYYY-MM-DD/,
  get_uncategorized: /YYYY-MM-DD/,
  month_comparison: /YYYY-MM/,
  preview_rule: /YYYY-MM-DD/,
  run_query: /YYYY-MM-DD/,
  spending_summary: /YYYY-MM-DD/,
  spending_trends: /YYYY-MM/,
  update_rule: /YYYY-MM-DD/,
  update_transaction: /YYYY-MM-DD/,
};

describe('the tools on offer', () => {
  it('are every tool, and in read-only mode only the ones that cannot change anything', async () => {
    for (const readOnly of [false, true]) {
      const { client, close } = await connectTestClient({
        session: budget.session,
        readOnly,
      });
      const { tools } = await client.listTools();

      expect(tools.map(tool => tool.name).sort()).toEqual(
        readOnly ? [...READ_TOOLS].sort() : TOOLS,
      );
      await close();
    }
  });

  it('describe what they return, and say which of them change data', async () => {
    const { client, close } = await connectTestClient({
      session: budget.session,
    });
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.name, tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);

      const writes = WRITE_TOOLS.includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writes);
      const properties = tool.inputSchema.properties ?? {};
      expect('dry_run' in properties, tool.name).toBe(writes);
      expect(tool.description, tool.name).toMatch(
        writes ? /Dry run by default/ : /^(?!.*Dry run by default)/s,
      );
      // Only a deletion asks for confirmation as well.
      expect('confirm' in properties, tool.name).toBe(
        tool.name === 'delete_rule',
      );
    }
    await close();
  });

  it('state their units and date formats, since the model reads them', async () => {
    const { client, close } = await connectTestClient({
      session: budget.session,
    });
    const { tools } = await client.listTools();
    const descriptions = new Map(
      tools.map(tool => [tool.name, tool.description ?? '']),
    );

    for (const name of REPORT_MONEY) {
      expect(descriptions.get(name), name).toMatch(/major currency units/);
    }
    for (const [name, format] of Object.entries(REPORT_DATES)) {
      expect(descriptions.get(name), name).toMatch(format);
    }
    await close();
  });
});

describe('the server', () => {
  it('tells the model the conventions up front', async () => {
    const { client, close } = await connectTestClient({
      session: budget.session,
    });

    expect(client.getInstructions()).toMatch(/get_overview first/);
    expect(client.getInstructions()).toMatch(/dollars, not cents/);
    await close();
  });
});
