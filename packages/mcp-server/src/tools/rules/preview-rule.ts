import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import { toRuleConditions } from '#actual/rule-input';
import { previewMatches } from '#actual/rule-matches';
import { describeRule } from '#actual/rules';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

import {
  CONDITIONS_HELP,
  conditionSchema,
  describeMatches,
  matchField,
  ruleMatchesSchema,
} from './rule-schemas';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const previewRule = defineTool({
  name: 'preview_rule',
  title: 'Preview a rule',
  description: `Show which existing transactions a set of rule conditions would match, without creating anything: how many, their net total, how they are categorized today, and the newest few. Use it to test conditions before create_rule, and to see whether a rule would also sweep up transactions that were categorized by hand. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. Rules only act on new transactions, so matches here are not changed; apply_rules_retroactively does that.`,
  kind: 'read',
  input: {
    conditions: z.array(conditionSchema).min(1).describe(CONDITIONS_HELP),
    match: matchField,
    start_date: isoDate
      .optional()
      .describe('Only look at transactions on or after this day, YYYY-MM-DD.'),
    end_date: isoDate
      .optional()
      .describe('Only look at transactions on or before this day, YYYY-MM-DD.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `How many of the newest matches to list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      ),
  },
  output: {
    summary: z.string().describe('The conditions in one sentence.'),
    matches: ruleMatchesSchema,
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const { conditions, warnings } = await toRuleConditions(
      ctx,
      createLookups(ctx),
      input.conditions,
    );
    const matches = await previewMatches(
      ctx,
      {
        conditions,
        match: input.match,
        startDate: input.start_date,
        endDate: input.end_date,
      },
      { limit: input.limit },
    );
    const { summary } = await describeRule(ctx, {
      stage: 'default',
      conditionsOp: input.match === 'any' ? 'or' : 'and',
      conditions,
      actions: [],
    });
    const conditionsText = summary
      .replace(/^If /, '')
      .replace(/, then do nothing$/, '');

    return {
      data: { summary: conditionsText, matches, warnings },
      text: [
        `Conditions: ${conditionsText}`,
        ...describeMatches(matches, ctx.amounts.format),
        ...warnings,
      ].join('\n'),
    };
  },
});
