import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { normalizeTicker } from '@actual-app/core/shared/rsu';
import type {
  RsuGrantEntity,
  StockPriceEntity,
} from '@actual-app/core/types/models';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { AmountInput } from '#components/util/AmountInput';
import { useFormat } from '#hooks/useFormat';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';

type StockPriceStripProps = {
  grants: readonly RsuGrantEntity[];
  priceByTicker: ReadonlyMap<string, StockPriceEntity>;
};

export function StockPriceStrip({
  grants,
  priceByTicker,
}: StockPriceStripProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const syncServerStatus = useSyncServerStatus();
  const [lastRefresh] = useMetadataPref('lastRsuPriceRefresh');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const tickers = [
    ...new Set(grants.map(grant => normalizeTicker(grant.ticker))),
  ].sort();

  async function refresh(force = false) {
    setIsRefreshing(true);
    try {
      const result = await send('rsu/refresh-prices', { force });
      const lock = result.error ? null : await send('rsu/lock-vest-prices', {});
      if (lock && lock.locked.length > 0) {
        dispatch(
          addNotification({
            notification: {
              type: 'message',
              message: t(
                'Locked the vest-date price for {{count}} past vests.',
                { count: lock.locked.length },
              ),
            },
          }),
        );
      }
      if (result.error === 'no-server') {
        dispatch(
          addNotification({
            notification: {
              type: 'warning',
              message: t(
                'Prices can only be fetched through a sync server. Enter them manually instead.',
              ),
            },
          }),
        );
      } else if (result.error) {
        dispatch(
          addNotification({
            notification: {
              type: 'error',
              message: t('Could not fetch stock prices ({{reason}}).', {
                reason: result.error,
              }),
            },
          }),
        );
      } else if (result.failed.length > 0) {
        dispatch(
          addNotification({
            notification: {
              type: 'warning',
              message: t('No price was found for {{tickers}}.', {
                tickers: result.failed.map(item => item.symbol).join(', '),
              }),
            },
          }),
        );
      }
    } finally {
      setIsRefreshing(false);
    }
  }

  if (tickers.length === 0) {
    return null;
  }

  const canFetch = syncServerStatus !== 'no-server';

  return (
    <View style={{ marginBottom: 15 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Share prices</Trans>
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {lastRefresh && (
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              {t('Last automatic refresh: {{date}}', { date: lastRefresh })}
            </Text>
          )}
          {canFetch ? (
            <Button
              variant="normal"
              isDisabled={isRefreshing}
              onPress={() => refresh(false)}
            >
              {isRefreshing ? t('Refreshing…') : t('Refresh prices')}
            </Button>
          ) : (
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              <Trans>
                No sync server is configured, so prices are entered manually.
              </Trans>
            </Text>
          )}
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {tickers.map(ticker => (
          <PriceCard
            key={ticker}
            ticker={ticker}
            price={priceByTicker.get(ticker)}
            canFetch={canFetch}
            onUseLivePrice={async () => {
              await send('rsu/set-price', { ticker, manual_override: false });
              await refresh(false);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function PriceCard({
  ticker,
  price,
  canFetch,
  onUseLivePrice,
}: {
  ticker: string;
  price: StockPriceEntity | undefined;
  canFetch: boolean;
  onUseLivePrice: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [isEditing, setIsEditing] = useState(false);

  const sourceLabel =
    price?.manual_override || price?.source === 'manual'
      ? t('Manual')
      : price?.source === 'stooq'
        ? t('Stooq')
        : price?.source === 'yahoo'
          ? t('Yahoo Finance')
          : null;

  return (
    <View
      style={{
        minWidth: 220,
        padding: '10px 12px',
        borderRadius: 6,
        border: `1px solid ${theme.tableBorder}`,
        backgroundColor: theme.tableBackground,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ fontWeight: 600 }}>{ticker}</Text>
        {sourceLabel && (
          <Text
            style={{
              fontSize: 11,
              color: theme.pageTextSubdued,
              padding: '2px 6px',
              borderRadius: 4,
              backgroundColor: theme.tableRowHeaderBackground,
            }}
          >
            {sourceLabel}
          </Text>
        )}
      </View>

      {isEditing ? (
        <AmountInput
          value={price?.price ?? 0}
          sign="+"
          focused
          onUpdate={async amount => {
            setIsEditing(false);
            if (amount >= 0) {
              await send('rsu/set-price', { ticker, price: amount });
            }
          }}
          onEnter={() => setIsEditing(false)}
        />
      ) : (
        <FinancialText style={{ fontSize: 18 }}>
          {price ? (
            <PrivacyFilter>{format(price.price, 'financial')}</PrivacyFilter>
          ) : (
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>No price yet</Trans>
            </Text>
          )}
          {price?.currency && (
            <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
              {' '}
              {price.currency}
            </Text>
          )}
        </FinancialText>
      )}

      <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
        {price?.as_of
          ? t('As of {{date}}', {
              date: new Date(price.as_of).toLocaleString(),
            })
          : t('Enter a price to estimate vest income')}
      </Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
        <Button
          variant="bare"
          onPress={() => setIsEditing(editing => !editing)}
        >
          {isEditing ? t('Cancel') : t('Set price')}
        </Button>
        {canFetch && price?.manual_override && (
          <Button variant="bare" onPress={onUseLivePrice}>
            <Trans>Use live price</Trans>
          </Button>
        )}
      </View>
    </View>
  );
}
