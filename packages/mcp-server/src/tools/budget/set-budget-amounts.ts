import { z } from 'zod';

import { applyBudgetChanges, planBudgetAmounts } from '#actual/budget-amounts';
import type { BudgetWish } from '#actual/budget-amounts';
import { createLookups } from '#actual/lookup';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoMonth } from '#tools/schemas';

const MAX_ENTRIES = 100;
const MAX_MONTHS_PER_ENTRY = 24;
const MAX_AMOUNTS = 600;

const changeSchema = z.object({
  month: z.string().describe('YYYY-MM.'),
  category: z.string(),
  is_income: z.boolean(),
  from: z.number().describe('The amount budgeted now, major units.'),
  to: z.number().describe('The amount budgeted after, major units.'),
});

const skipSchema = z.object({
  month: z.string().describe('YYYY-MM.'),
  category: z.string(),
  reason: z.string(),
});

const totalsSchema = z.object({
  month: z.string().describe('YYYY-MM.'),
  expense_before: z
    .number()
    .describe('Everything budgeted in the expense groups, major units.'),
  expense_after: z.number(),
  income_before: z
    .number()
    .nullable()
    .describe('Null for an envelope budget, which does not budget income.'),
  income_after: z.number().nullable(),
});

export const setBudgetAmounts = defineTool({
  name: 'set_budget_amounts',
  title: 'Set budget amounts',
  description:
    "Sets how much is budgeted for categories in one or more months, for example to project next quarter's costs and measure actual spending against them (get_budget_month and month_comparison show budgeted against actual). Give each entry as a category (name or id), the months (YYYY-MM, each one that get_budget_months lists) and one amount for all of those months. Amounts are in major currency units (e.g. dollars, not cents) and are positive, unlike spending in transactions: 2700 means 2700.00 budgeted. An amount of 0 clears a budget. Only the categories given are touched. Income categories can be budgeted only in a tracking budget; an envelope budget skips them and says so. An envelope budget and a tracking budget keep separate amounts, so what is set here is saved for the budget type in use now (the preview says which), and switching type in Actual's settings shows the other type's amounts, not these. The preview lists every change with the amount before and after and each month's budgeted total before and after.",
  kind: 'write',
  input: {
    entries: z
      .array(
        z.object({
          category: z
            .string()
            .min(1)
            .describe('A category name (case-insensitive) or id.'),
          months: z
            .array(isoMonth)
            .min(1)
            .max(MAX_MONTHS_PER_ENTRY)
            .describe('The months to set, each YYYY-MM.'),
          amount: z
            .number()
            .min(0)
            .describe(
              'The amount to budget in each of those months, major units, zero or more.',
            ),
        }),
      )
      .min(1)
      .max(MAX_ENTRIES)
      .describe('The categories and amounts to set.'),
  },
  output: {
    budget_type: z.enum(['envelope', 'tracking']),
    changed_count: z
      .number()
      .describe('Amounts that differ from what is budgeted now.'),
    unchanged_count: z
      .number()
      .describe('Amounts that already were what was asked for.'),
    skipped_count: z.number(),
    applied_count: z
      .number()
      .describe('Amounts really written; always 0 for a preview.'),
    changes: z.array(changeSchema),
    skipped: z.array(skipSchema),
    totals: z.array(totalsSchema),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const lookups = createLookups(ctx);
    const wishes: BudgetWish[] = [];
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const category = await lookups.category(entry.category);
      for (const month of new Set(entry.months)) {
        const key = `${month}/${category.id}`;
        if (seen.has(key)) {
          throw toolError(
            `${category.name} is given more than once for ${month}. Give each category and month once.`,
          );
        }
        seen.add(key);
        wishes.push({ month, category, amount: entry.amount });
      }
    }
    if (wishes.length > MAX_AMOUNTS) {
      throw toolError(
        `that is ${wishes.length} amounts; set at most ${MAX_AMOUNTS} at a time.`,
      );
    }

    const plan = await planBudgetAmounts(ctx, wishes);
    if (!ctx.dryRun) await applyBudgetChanges(ctx, plan.changes);
    const applied = ctx.dryRun ? 0 : plan.changes.length;

    const warnings: string[] = [];
    if (plan.budget_type === 'envelope') {
      warnings.push(
        'This is an envelope budget, so these amounts come out of To Budget, and income categories cannot be budgeted. A tracking budget keeps its own amounts: if you switch to one in Actual, set them again there.',
      );
    }

    const { format } = ctx.amounts;
    const lines: string[] = [];
    for (const total of plan.totals) {
      lines.push(
        `${total.month}: expenses budgeted ${format(total.expense_before)} -> ${format(total.expense_after)}${
          total.income_before === null || total.income_after === null
            ? ''
            : `, income budgeted ${format(total.income_before)} -> ${format(total.income_after)}`
        }`,
      );
      for (const change of plan.changes.filter(c => c.month === total.month)) {
        lines.push(
          `  ${change.category}: ${format(change.from)} -> ${format(change.to)}`,
        );
      }
    }
    for (const skip of plan.skipped) {
      lines.push(`  skipped ${skip.category} in ${skip.month}: ${skip.reason}`);
    }
    const header = `${ctx.dryRun ? 'Would set' : 'Set'} ${plan.changes.length} budget amount(s) in a ${plan.budget_type} budget (${plan.unchanged} already right, ${plan.skipped.length} skipped).`;

    return {
      data: {
        budget_type: plan.budget_type,
        changed_count: plan.changes.length,
        unchanged_count: plan.unchanged,
        skipped_count: plan.skipped.length,
        applied_count: applied,
        changes: plan.changes.map(change => ({
          month: change.month,
          category: change.category,
          is_income: change.is_income,
          from: change.from,
          to: change.to,
        })),
        skipped: plan.skipped,
        totals: plan.totals,
        warnings,
      },
      text: [header, ...lines, ...warnings].join('\n'),
    };
  },
});
