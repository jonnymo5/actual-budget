import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { projectRsuIncomeByMonth } from '@actual-app/core/shared/rsu';
import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '@actual-app/core/types/models';
import { format as formatDate } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';

type RsuYearGridProps = {
  grants: readonly RsuGrantEntity[];
  events: readonly RsuVestEventEntity[];
  prices: readonly StockPriceEntity[];
  today: string;
};

const NAME_WIDTH = 180;
const TOTAL_WIDTH = 110;

export function RsuYearGrid({
  grants,
  events,
  prices,
  today,
}: RsuYearGridProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const locale = useLocale();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);

  const projection = projectRsuIncomeByMonth({
    grants,
    events,
    prices,
    year,
  });

  const monthLabels = Array.from({ length: 12 }, (_, index) =>
    formatDate(new Date(year, index, 1), 'MMM', { locale }),
  );

  const cellStyle = {
    flex: 1,
    minWidth: 70,
    padding: '0 6px',
    justifyContent: 'center',
    textAlign: 'right' as const,
  };

  function renderAmount(amount: number, recorded = false) {
    if (amount === 0) {
      return <Text style={{ color: theme.pageTextSubdued }}>–</Text>;
    }
    return (
      <FinancialText
        style={{ color: recorded ? theme.noticeText : theme.tableText }}
        title={recorded ? t('Includes recorded amounts') : undefined}
      >
        <PrivacyFilter>{format(amount, 'financial')}</PrivacyFilter>
      </FinancialText>
    );
  }

  return (
    <View style={{ marginTop: 20 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Estimated net income by month</Trans>
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Button variant="bare" onPress={() => setYear(year - 1)}>
            <Trans>Previous year</Trans>
          </Button>
          <Text style={{ fontWeight: 600, minWidth: 40, textAlign: 'center' }}>
            {year}
          </Text>
          <Button variant="bare" onPress={() => setYear(year + 1)}>
            <Trans>Next year</Trans>
          </Button>
          {year !== currentYear && (
            <Button variant="bare" onPress={() => setYear(currentYear)}>
              <Trans>This year</Trans>
            </Button>
          )}
        </View>
      </View>

      <View
        style={{
          border: `1px solid ${theme.tableBorder}`,
          borderRadius: 6,
          overflow: 'auto',
          backgroundColor: theme.tableBackground,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: theme.tableHeaderBackground,
            color: theme.tableHeaderText,
            fontWeight: 500,
            height: 36,
            ...styles.smallText,
          }}
        >
          <View
            style={{
              width: NAME_WIDTH,
              padding: '0 10px',
              justifyContent: 'center',
            }}
          >
            <Trans>Grant</Trans>
          </View>
          {monthLabels.map(label => (
            <View key={label} style={cellStyle}>
              {label}
            </View>
          ))}
          <View style={{ ...cellStyle, width: TOTAL_WIDTH, flex: 'none' }}>
            <Trans>Total</Trans>
          </View>
        </View>

        {projection.rows.length === 0 && (
          <View style={{ padding: 15, alignItems: 'center' }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>Add a grant to see its projected income here.</Trans>
            </Text>
          </View>
        )}

        {projection.rows.map(row => {
          const grant = grants.find(g => g.id === row.grantId);
          return (
            <View
              key={row.grantId}
              style={{
                flexDirection: 'row',
                height: 36,
                borderTop: `1px solid ${theme.tableBorder}`,
                ...styles.smallText,
              }}
            >
              <View
                style={{
                  width: NAME_WIDTH,
                  padding: '0 10px',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                <Text
                  style={{
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                  }}
                  title={grant?.name}
                >
                  {grant?.name}
                </Text>
              </View>
              {row.months.map((amount, index) => (
                <View key={index} style={cellStyle}>
                  {renderAmount(amount, row.recordedMonths.includes(index))}
                </View>
              ))}
              <View
                style={{
                  ...cellStyle,
                  width: TOTAL_WIDTH,
                  flex: 'none',
                  fontWeight: 600,
                }}
              >
                {renderAmount(row.total)}
              </View>
            </View>
          );
        })}

        {projection.rows.length > 1 && (
          <View
            style={{
              flexDirection: 'row',
              height: 36,
              borderTop: `2px solid ${theme.tableBorder}`,
              fontWeight: 600,
              ...styles.smallText,
            }}
          >
            <View
              style={{
                width: NAME_WIDTH,
                padding: '0 10px',
                justifyContent: 'center',
              }}
            >
              <Trans>All grants</Trans>
            </View>
            {projection.totals.map((amount, index) => (
              <View key={index} style={cellStyle}>
                {renderAmount(amount)}
              </View>
            ))}
            <View style={{ ...cellStyle, width: TOTAL_WIDTH, flex: 'none' }}>
              {renderAmount(projection.grandTotal)}
            </View>
          </View>
        )}
      </View>

      {projection.missingPriceTickers.length > 0 && (
        <Text
          style={{ marginTop: 8, color: theme.warningTextDark, fontSize: 13 }}
        >
          {t(
            'Vests for {{tickers}} are left out until a share price is available.',
            { tickers: projection.missingPriceTickers.join(', ') },
          )}
        </Text>
      )}
    </View>
  );
}
