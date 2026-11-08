import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Checkbox } from '#components/forms';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

type RsuBudgetSyncProps = {
  hasGrants: boolean;
};

export function RsuBudgetSync({ hasGrants }: RsuBudgetSyncProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const [enabled, setEnabled] = useSyncedPref('rsu-budget-sync');

  // Only a tracking budget can budget income.
  if (!hasGrants || budgetType !== 'tracking') {
    return null;
  }

  async function onChange(checked: boolean) {
    setEnabled(checked ? 'true' : 'false');
    if (!checked) {
      return;
    }
    const result = await send('rsu/sync-budget', {});
    dispatch(
      addNotification({
        notification: {
          type: 'message',
          message: t(
            'Budgeted expected income for the next 12 months ({{count}} months changed).',
            { count: result.changes.length },
          ),
        },
      }),
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginBottom: 15,
      }}
    >
      <Checkbox
        id="rsu-budget-sync"
        checked={enabled === 'true'}
        onChange={e => void onChange(e.target.checked)}
      />
      <View style={{ gap: 2 }}>
        <label htmlFor="rsu-budget-sync" style={{ fontWeight: 600 }}>
          <Trans>Budget expected income automatically</Trans>
        </label>
        <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
          <Trans>
            Once a day, after prices refresh, each month from now to a year
            ahead is budgeted with the net of every vest in it plus every
            scheduled deposit tagged with an income category. This replaces
            whatever was budgeted in those income categories.
          </Trans>
        </Text>
      </View>
    </View>
  );
}
