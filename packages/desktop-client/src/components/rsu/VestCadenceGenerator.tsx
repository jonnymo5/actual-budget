import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  generateVestEvents,
  RSU_FREQUENCIES,
} from '@actual-app/core/shared/rsu';
import type {
  RsuVestFrequency,
  RsuVestRow,
} from '@actual-app/core/types/models';

import { FormField, FormLabel } from '#components/forms';
import { DateSelect } from '#components/select/DateSelect';
import { PercentInput } from '#components/util/PercentInput';
import { useDateFormat } from '#hooks/useDateFormat';

type VestCadenceGeneratorProps = {
  totalShares: number;
  defaultStart: string;
  hasRows: boolean;
  onGenerate: (rows: RsuVestRow[]) => void;
};

export function VestCadenceGenerator({
  totalShares,
  defaultStart,
  hasRows,
  onGenerate,
}: VestCadenceGeneratorProps) {
  const { t } = useTranslation();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  const [vestStart, setVestStart] = useState(defaultStart);
  const [frequency, setFrequency] = useState<RsuVestFrequency>('quarterly');
  const [periods, setPeriods] = useState(16);
  const [cliffPercent, setCliffPercent] = useState(0);
  const [cliffMonths, setCliffMonths] = useState(12);

  const frequencyLabels: Record<RsuVestFrequency, string> = {
    monthly: t('Monthly'),
    quarterly: t('Quarterly'),
    semiannual: t('Every six months'),
    annual: t('Yearly'),
  };

  const preview = generateVestEvents({
    totalShares,
    vestStart,
    frequency,
    periods,
    cliffPercent,
    cliffMonths,
  });

  return (
    <View
      style={{
        padding: 12,
        borderRadius: 6,
        backgroundColor: theme.tableRowHeaderBackground,
        gap: 10,
      }}
    >
      <Text style={{ fontWeight: 600 }}>
        <Trans>Generate vest rows from a cadence</Trans>
      </Text>
      <View
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 10,
        }}
      >
        <FormField>
          <FormLabel title={t('Vesting starts')} htmlFor="rsu-vest-start" />
          <DateSelect
            id="rsu-vest-start"
            value={vestStart}
            dateFormat={dateFormat}
            onSelect={setVestStart}
          />
        </FormField>
        <FormField>
          <FormLabel title={t('Frequency')} htmlFor="rsu-frequency" />
          <Select
            id="rsu-frequency"
            options={RSU_FREQUENCIES.map(
              value => [value, frequencyLabels[value]] as const,
            )}
            value={frequency}
            onChange={setFrequency}
          />
        </FormField>
        <FormField>
          <FormLabel title={t('Periods')} htmlFor="rsu-periods" />
          <Input
            id="rsu-periods"
            inputMode="numeric"
            value={String(periods)}
            onChangeValue={value => setPeriods(parseCount(value, periods))}
          />
        </FormField>
        <FormField>
          <FormLabel title={t('Cliff')} htmlFor="rsu-cliff-percent" />
          <PercentInput
            id="rsu-cliff-percent"
            value={cliffPercent}
            onUpdatePercent={setCliffPercent}
          />
        </FormField>
        <FormField>
          <FormLabel
            title={t('Cliff after (months)')}
            htmlFor="rsu-cliff-months"
          />
          <Input
            id="rsu-cliff-months"
            inputMode="numeric"
            disabled={cliffPercent <= 0}
            value={String(cliffMonths)}
            onChangeValue={value =>
              setCliffMonths(parseCount(value, cliffMonths))
            }
          />
        </FormField>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
          {cliffPercent > 0
            ? t(
                '{{count}} rows: {{cliff}}% vests {{months}} months after the start, the rest every period after that.',
                {
                  count: preview.length,
                  cliff: cliffPercent,
                  months: cliffMonths,
                },
              )
            : t('{{count}} rows of equal size, the first on the start date.', {
                count: preview.length,
              })}
        </Text>
        <Button
          variant="normal"
          isDisabled={preview.length === 0}
          onPress={() => onGenerate(preview)}
        >
          {hasRows ? t('Replace rows') : t('Generate rows')}
        </Button>
      </View>
    </View>
  );
}

function parseCount(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return value.trim() === '' ? 0 : fallback;
  }
  return Math.min(parsed, 600);
}
