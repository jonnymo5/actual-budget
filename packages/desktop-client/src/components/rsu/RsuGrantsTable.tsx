import React, { useRef } from 'react';
import type { CSSProperties } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgDotsHorizontalTriple } from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { format as formatMonthDate } from '@actual-app/core/shared/months';
import {
  normalizeTicker,
  roundShares,
  sumShares,
  vestEventNet,
} from '@actual-app/core/shared/rsu';
import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '@actual-app/core/types/models';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { Field, Row, Table, TableHeader } from '#components/table';
import { useContextMenu } from '#hooks/useContextMenu';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';

export type RsuGrantAction = 'sync' | 'delete';

type RsuGrantsTableProps = {
  isLoading: boolean;
  grants: readonly RsuGrantEntity[];
  eventsByGrant: ReadonlyMap<string, RsuVestEventEntity[]>;
  priceByTicker: ReadonlyMap<string, StockPriceEntity>;
  today: string;
  onSelect: (id: RsuGrantEntity['id']) => void;
  onAction: (action: RsuGrantAction, id: RsuGrantEntity['id']) => void;
  style?: CSSProperties;
};

const ROW_HEIGHT = 43;

export function RsuGrantsTable({
  isLoading,
  grants,
  eventsByGrant,
  priceByTicker,
  today,
  onSelect,
  onAction,
  style,
}: RsuGrantsTableProps) {
  const { t } = useTranslation();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  return (
    <View style={{ flex: 1, ...style }}>
      <TableHeader height={ROW_HEIGHT} inset={15}>
        <Field width="flex">
          <Trans>Grant</Trans>
        </Field>
        <Field width={80}>
          <Trans>Ticker</Trans>
        </Field>
        <Field width={110}>
          <Trans>Granted</Trans>
        </Field>
        <Field width={150}>
          <Trans>Shares vested</Trans>
        </Field>
        <Field width={170}>
          <Trans>Next vest</Trans>
        </Field>
        <Field width={140} style={{ textAlign: 'right' }}>
          <Trans>Remaining est. net</Trans>
        </Field>
        <Field width={40} />
      </TableHeader>
      <Table
        rowHeight={ROW_HEIGHT}
        backgroundColor="transparent"
        style={{ flex: 1, backgroundColor: 'transparent' }}
        items={[...grants]}
        loading={isLoading}
        renderEmpty={t('No RSU grants yet')}
        renderItem={({ item }) => (
          <GrantRow
            grant={item}
            events={eventsByGrant.get(item.id) ?? []}
            price={priceByTicker.get(normalizeTicker(item.ticker))}
            today={today}
            dateFormat={dateFormat}
            onSelect={onSelect}
            onAction={onAction}
          />
        )}
      />
    </View>
  );
}

function GrantRow({
  grant,
  events,
  price,
  today,
  dateFormat,
  onSelect,
  onAction,
}: {
  grant: RsuGrantEntity;
  events: RsuVestEventEntity[];
  price: StockPriceEntity | undefined;
  today: string;
  dateFormat: string;
  onSelect: RsuGrantsTableProps['onSelect'];
  onAction: RsuGrantsTableProps['onAction'];
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const vested = events.filter(event => event.vest_date < today);
  const upcoming = events.filter(event => event.vest_date >= today);
  const nextEvent = upcoming[0];
  const nextNet = nextEvent ? vestEventNet(nextEvent, grant, price) : null;
  const remainingNet = upcoming.reduce<number | null>((total, event) => {
    const net = vestEventNet(event, grant, price);
    if (net == null) {
      return total;
    }
    return (total ?? 0) + net;
  }, null);

  const openMenu = () => {
    buttonRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
  };

  useContextMenu({
    triggerRef: rowRef,
    items: [
      { name: 'edit', text: t('Edit'), onClick: () => onSelect(grant.id) },
      {
        name: 'sync',
        text: t('Sync schedules'),
        onClick: () => onAction('sync', grant.id),
      },
      {
        name: 'delete',
        text: t('Delete'),
        onClick: () => onAction('delete', grant.id),
      },
    ],
  });

  return (
    <Row
      ref={rowRef}
      height={ROW_HEIGHT}
      inset={15}
      onClick={() => onSelect(grant.id)}
      style={{
        cursor: 'pointer',
        backgroundColor: theme.tableBackground,
        color: theme.tableText,
        ':hover': { backgroundColor: theme.tableRowBackgroundHover },
      }}
    >
      <Field width="flex" name="name">
        <Text title={grant.name}>{grant.name}</Text>
      </Field>
      <Field width={80} name="ticker">
        {normalizeTicker(grant.ticker)}
      </Field>
      <Field width={110} name="grant-date">
        {grant.grant_date ? formatMonthDate(grant.grant_date, dateFormat) : ''}
      </Field>
      <Field width={150} name="shares">
        <FinancialText>
          {t('{{vested}} of {{total}}', {
            vested: roundShares(sumShares(vested)),
            total: roundShares(grant.total_shares),
          })}
        </FinancialText>
      </Field>
      <Field width={170} name="next-vest">
        {nextEvent ? (
          <View
            style={{ flexDirection: 'row', gap: 6, alignItems: 'baseline' }}
          >
            <Text>{formatMonthDate(nextEvent.vest_date, dateFormat)}</Text>
            {nextNet != null && (
              <FinancialText style={{ color: theme.noticeTextLight }}>
                <PrivacyFilter>+{format(nextNet, 'financial')}</PrivacyFilter>
              </FinancialText>
            )}
          </View>
        ) : (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>Fully vested</Trans>
          </Text>
        )}
      </Field>
      <Field width={140} name="remaining" style={{ textAlign: 'right' }}>
        {remainingNet != null ? (
          <FinancialText>
            <PrivacyFilter>{format(remainingNet, 'financial')}</PrivacyFilter>
          </FinancialText>
        ) : upcoming.length > 0 ? (
          <Text style={{ color: theme.warningTextDark }}>
            <Trans>Needs price</Trans>
          </Text>
        ) : null}
      </Field>
      <Field width={40} name="actions" style={{ alignItems: 'center' }}>
        <Button
          ref={buttonRef}
          variant="bare"
          aria-label={t('Menu')}
          onPress={openMenu}
        >
          <SvgDotsHorizontalTriple style={{ width: 15, height: 15 }} />
        </Button>
      </Field>
    </Row>
  );
}
