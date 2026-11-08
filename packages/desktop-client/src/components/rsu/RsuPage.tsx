import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { RsuGrantEntity } from '@actual-app/core/types/models';

import { FeatureErrorFallback } from '#components/FeatureErrorFallback';
import { Page } from '#components/Page';
import { pushModal } from '#modals/modalsSlice';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

import { RsuGrantsTable } from './RsuGrantsTable';
import type { RsuGrantAction } from './RsuGrantsTable';
import { RsuYearGrid } from './RsuYearGrid';
import { StockPriceStrip } from './StockPriceStrip';
import { useRsuData } from './useRsuData';

export function RsuPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const {
    isLoading,
    grants,
    events,
    prices,
    eventsByGrant,
    priceByTicker,
    today,
  } = useRsuData();

  function onEdit(id: RsuGrantEntity['id']) {
    dispatch(pushModal({ modal: { name: 'rsu-grant-edit', options: { id } } }));
  }

  function onAdd() {
    dispatch(pushModal({ modal: { name: 'rsu-grant-edit', options: {} } }));
  }

  async function onAction(action: RsuGrantAction, id: RsuGrantEntity['id']) {
    switch (action) {
      case 'sync':
        await send('rsu/sync-schedules', { grantId: id });
        break;
      case 'match-deposits': {
        const result = await send('rsu/match-deposits', { grantId: id });
        dispatch(
          addNotification({
            notification: {
              type: result.matched.length > 0 ? 'message' : 'warning',
              message:
                result.matched.length > 0
                  ? t('Recorded {{count}} deposits as actual vest income.', {
                      count: result.matched.length,
                    })
                  : t(
                      'No unmatched deposits were found near the past vest dates.',
                    ),
            },
          }),
        );
        break;
      }
      case 'delete':
        await send('rsu-grant/delete', { id });
        break;
      default:
        throw new Error(`Unknown action: ${String(action)}`);
    }
  }

  return (
    <ErrorBoundary FallbackComponent={FeatureErrorFallback}>
      <Page header={t('RSU Grants')}>
        <StockPriceStrip grants={grants} priceByTicker={priceByTicker} />

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <Text style={{ fontWeight: 600 }}>
            <Trans>Grants</Trans>
          </Text>
          <Button variant="primary" onPress={onAdd}>
            <Trans>Add grant</Trans>
          </Button>
        </View>

        <RsuGrantsTable
          isLoading={isLoading}
          grants={grants}
          eventsByGrant={eventsByGrant}
          priceByTicker={priceByTicker}
          today={today}
          onSelect={onEdit}
          onAction={onAction}
          style={{
            backgroundColor: theme.tableBackground,
            maxHeight: Math.max(120, Math.min(grants.length, 8) * 43 + 43),
          }}
        />

        <RsuYearGrid
          grants={grants}
          events={events}
          prices={prices}
          today={today}
        />
      </Page>
    </ErrorBoundary>
  );
}
