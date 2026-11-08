import React from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgDelete } from '@actual-app/components/icons/v0';
import { Input } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  roundShares,
  sumShares,
  vestEventValue,
} from '@actual-app/core/shared/rsu';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { DateSelect } from '#components/select/DateSelect';
import { AmountInput } from '#components/util/AmountInput';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';

import { getVestStatus } from './useRsuData';
import type { VestStatus } from './useRsuData';
import { VestStatusBadge } from './VestStatusBadge';

export type VestRowDraft = {
  /** Client-side key; stable across edits */
  key: string;
  /** Set for rows that already exist in the budget */
  id?: string;
  vest_date: string;
  shares: number;
  /** Share price locked on the vest date, cents */
  actual_price: number | null;
  actual_net: number | null;
  schedule: string | null;
};

type VestEventsEditorProps = {
  rows: VestRowDraft[];
  onChange: (rows: VestRowDraft[]) => void;
  totalShares: number;
  priceCents: number | null;
  withholdingRate: number;
  statusByEvent: ReadonlyMap<string, VestStatus>;
  today: string;
};

const COLUMNS = {
  date: 140,
  shares: 90,
  price: 120,
  gross: 110,
  net: 110,
  status: 120,
  actual: 120,
  remove: 36,
};

export function VestEventsEditor({
  rows,
  onChange,
  totalShares,
  priceCents,
  withholdingRate,
  statusByEvent,
  today,
}: VestEventsEditorProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  const rowTotal = roundShares(sumShares(rows));
  const totalMismatch =
    totalShares > 0 && Math.abs(rowTotal - roundShares(totalShares)) > 1e-6;

  function update(key: string, patch: Partial<VestRowDraft>) {
    onChange(rows.map(row => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    const last = rows[rows.length - 1];
    onChange([
      ...rows,
      {
        key: newRowKey(),
        vest_date: last?.vest_date ?? today,
        shares: last?.shares ?? 0,
        actual_price: null,
        actual_net: null,
        schedule: null,
      },
    ]);
  }

  const headerCell = (width: number, label: ReactNode, align?: 'right') => (
    <View style={{ width, padding: '0 5px', textAlign: align }}>{label}</View>
  );

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Vest rows</Trans>
        </Text>
        <Text
          style={{
            fontSize: 13,
            color: totalMismatch
              ? theme.warningTextDark
              : theme.pageTextSubdued,
          }}
        >
          {totalMismatch
            ? t(
                'Rows add up to {{rowTotal}} shares, but the grant has {{total}}.',
                {
                  rowTotal,
                  total: roundShares(totalShares),
                },
              )
            : t('{{count}} rows, {{rowTotal}} shares', {
                count: rows.length,
                rowTotal,
              })}
        </Text>
      </View>

      <View
        style={{
          border: `1px solid ${theme.tableBorder}`,
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: 32,
            backgroundColor: theme.tableHeaderBackground,
            color: theme.tableHeaderText,
            fontWeight: 500,
            ...styles.smallText,
          }}
        >
          {headerCell(COLUMNS.date, t('Vest date'))}
          {headerCell(COLUMNS.shares, t('Shares'), 'right')}
          {headerCell(COLUMNS.price, t('Vest price'), 'right')}
          {headerCell(COLUMNS.gross, t('Gross'), 'right')}
          {headerCell(COLUMNS.net, t('Net'), 'right')}
          {headerCell(COLUMNS.status, t('Status'))}
          {headerCell(COLUMNS.actual, t('Actual net'), 'right')}
          {headerCell(COLUMNS.remove, '')}
        </View>

        {rows.length === 0 && (
          <View style={{ padding: 12, alignItems: 'center' }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>No vest rows yet. Generate them above or add one.</Trans>
            </Text>
          </View>
        )}

        {rows.map(row => {
          const estimate = vestEventValue(
            row,
            { withholding_rate: withholdingRate },
            priceCents != null ? { price: priceCents } : null,
          );
          const isCurrentEstimate = estimate?.basis === 'current';
          const status = row.id
            ? statusByEvent.get(row.id)
            : getVestStatus({
                event: row,
                scheduleStatus: undefined,
                hasPrice: priceCents != null,
                today,
              });
          return (
            <View
              key={row.key}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: 40,
                borderTop: `1px solid ${theme.tableBorder}`,
                backgroundColor: theme.tableBackground,
                ...styles.smallText,
              }}
            >
              <View style={{ width: COLUMNS.date, padding: '0 5px' }}>
                <DateSelect
                  value={row.vest_date}
                  dateFormat={dateFormat}
                  onSelect={date => update(row.key, { vest_date: date })}
                />
              </View>
              <View style={{ width: COLUMNS.shares, padding: '0 5px' }}>
                <Input
                  inputMode="decimal"
                  style={{ textAlign: 'right' }}
                  // Uncontrolled: parsed when the field loses focus
                  key={`${row.key}-${row.shares}`}
                  defaultValue={String(row.shares)}
                  onUpdate={value =>
                    update(row.key, { shares: parseShares(value, row.shares) })
                  }
                />
              </View>
              <View style={{ width: COLUMNS.price, padding: '0 5px' }}>
                <AmountInput
                  value={row.actual_price ?? 0}
                  sign="+"
                  onUpdate={amount =>
                    update(row.key, {
                      actual_price: amount > 0 ? amount : null,
                    })
                  }
                />
              </View>
              <View
                style={{
                  width: COLUMNS.gross,
                  padding: '0 5px',
                  textAlign: 'right',
                }}
                title={
                  isCurrentEstimate
                    ? t('Estimated from the current share price')
                    : undefined
                }
              >
                {estimate && (
                  <FinancialText
                    style={{
                      color: isCurrentEstimate
                        ? theme.pageTextSubdued
                        : theme.tableText,
                    }}
                  >
                    <PrivacyFilter>
                      {format(estimate.gross, 'financial')}
                    </PrivacyFilter>
                  </FinancialText>
                )}
              </View>
              <View
                style={{
                  width: COLUMNS.net,
                  padding: '0 5px',
                  textAlign: 'right',
                }}
              >
                {estimate && (
                  <FinancialText
                    style={{
                      color: isCurrentEstimate
                        ? theme.pageTextSubdued
                        : theme.noticeTextLight,
                    }}
                  >
                    <PrivacyFilter>
                      {format(estimate.net, 'financial')}
                    </PrivacyFilter>
                  </FinancialText>
                )}
              </View>
              <View
                style={{
                  width: COLUMNS.status,
                  padding: '0 5px',
                  alignItems: 'flex-start',
                }}
              >
                <VestStatusBadge status={status} />
              </View>
              <View style={{ width: COLUMNS.actual, padding: '0 5px' }}>
                <AmountInput
                  value={row.actual_net ?? 0}
                  sign="+"
                  onUpdate={amount =>
                    update(row.key, { actual_net: amount > 0 ? amount : null })
                  }
                />
              </View>
              <View style={{ width: COLUMNS.remove, alignItems: 'center' }}>
                <Button
                  variant="bare"
                  aria-label={t('Remove row')}
                  onPress={() => onChange(rows.filter(r => r.key !== row.key))}
                >
                  <SvgDelete style={{ width: 10, height: 10 }} />
                </Button>
              </View>
            </View>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row' }}>
        <Button variant="bare" onPress={addRow}>
          <Trans>Add row</Trans>
        </Button>
      </View>
    </View>
  );
}

let rowCounter = 0;
export function newRowKey(): string {
  rowCounter += 1;
  return `draft-${Date.now()}-${rowCounter}`;
}

function parseShares(value: string, fallback: number): number {
  const parsed = Number(value.replace(/,/g, '').trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return roundShares(parsed);
}
