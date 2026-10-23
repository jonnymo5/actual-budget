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

// Every tool the server offers today. Adding a tool means adding it here, and
// to one of the lists below, so its description is held to the same standard.
const TOOLS = [
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
  'list_accounts',
  'month_comparison',
  'run_query',
  'spending_summary',
  'spending_trends',
];

// Tools whose results include money must say it is in major units.
const REPORT_MONEY = [
  'cash_flow_projection',
  'detect_recurring',
  'find_outliers',
  'get_budget_month',
  'get_overview',
  'get_rules',
  'get_schedules',
  'get_transactions',
  'list_accounts',
  'month_comparison',
  'run_query',
  'spending_summary',
  'spending_trends',
];

// Tools that take or return dates must say how they are written.
const REPORT_DATES: Record<string, RegExp> = {
  cash_flow_projection: /YYYY-MM-DD/,
  detect_recurring: /YYYY-MM-DD/,
  find_outliers: /YYYY-MM-DD/,
  get_budget_month: /YYYY-MM/,
  get_budget_months: /YYYY-MM/,
  get_overview: /YYYY-MM-DD/,
  get_rules: /YYYY-MM-DD/,
  get_schedules: /YYYY-MM-DD/,
  get_transactions: /YYYY-MM-DD/,
  month_comparison: /YYYY-MM/,
  run_query: /YYYY-MM-DD/,
  spending_summary: /YYYY-MM-DD/,
  spending_trends: /YYYY-MM/,
};

describe('the tools on offer', () => {
  it('are the query and analysis tools, and all of them still show up in read-only mode', async () => {
    for (const readOnly of [false, true]) {
      const { client, close } = await connectTestClient({
        session: budget.session,
        readOnly,
      });
      const { tools } = await client.listTools();

      expect(tools.map(tool => tool.name).sort()).toEqual(TOOLS);
      await close();
    }
  });

  it('are all read-only and describe what they return', async () => {
    const { client, close } = await connectTestClient({
      session: budget.session,
    });
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.name, tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
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
