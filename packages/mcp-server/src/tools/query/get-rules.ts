import { z } from 'zod';

import { listRules } from '#actual/rules';
import { defineTool } from '#tools/registry';
import { ruleBodyShape } from '#tools/rules/rule-schemas';

export const getRules = defineTool({
  name: 'get_rules',
  title: 'List rules',
  description:
    'List the automation rules that run on new and imported transactions, such as "if the payee is Costco, set the category to Groceries". Each rule has conditions, actions and a one-sentence summary with ids replaced by names. Amounts inside rules are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. Pass payee_id to see only the rules that mention one payee. The rule Actual keeps behind each schedule to match its transactions is not listed unless include_schedule_rules is true; get_schedules covers schedules.',
  kind: 'read',
  input: {
    payee_id: z
      .string()
      .min(1)
      .optional()
      .describe('Only rules that mention this payee (id from get_payees).'),
    include_schedule_rules: z
      .boolean()
      .default(false)
      .describe('Also list the rules that schedules create behind the scenes.'),
  },
  output: {
    rules: z.array(z.object({ id: z.string(), ...ruleBodyShape })),
  },
  async handler({ payee_id, include_schedule_rules }, ctx) {
    const rules = await listRules(ctx, {
      payeeId: payee_id,
      includeScheduleRules: include_schedule_rules,
    });

    const lines = rules.map(rule => `${rule.summary} [id: ${rule.id}]`);
    return {
      data: { rules },
      text: lines.length > 0 ? lines.join('\n') : 'No rules.',
    };
  },
});
