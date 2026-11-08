import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { sendCatch } from '@actual-app/core/platform/client/connection';
import {
  normalizeTicker,
  roundShares,
  sumShares,
} from '@actual-app/core/shared/rsu';
import type { RsuVestRow } from '@actual-app/core/types/models';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import { DateSelect } from '#components/select/DateSelect';
import { GenericInput } from '#components/util/GenericInput';
import { PercentInput } from '#components/util/PercentInput';
import { useDateFormat } from '#hooks/useDateFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';

import { useRsuData } from './useRsuData';
import { VestCadenceGenerator } from './VestCadenceGenerator';
import { newRowKey, VestEventsEditor } from './VestEventsEditor';
import type { VestRowDraft } from './VestEventsEditor';

type RsuGrantEditModalProps = Extract<
  ModalType,
  { name: 'rsu-grant-edit' }
>['options'];

type GrantDraft = {
  name: string;
  ticker: string;
  grant_date: string | null;
  total_shares: number;
  account: string;
  category: string | null;
  payee: string;
  withholding_rate: number;
  notes: string;
};

export function RsuGrantEditModal({ id }: RsuGrantEditModalProps) {
  const { t } = useTranslation();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const {
    grants,
    eventsByGrant,
    priceByTicker,
    statusByEvent,
    isLoading,
    today,
  } = useRsuData();

  const adding = id == null;
  const [grant, setGrant] = useState<GrantDraft | null>(
    adding
      ? {
          name: '',
          ticker: '',
          grant_date: today,
          total_shares: 0,
          account: '',
          category: null,
          payee: '',
          withholding_rate: 0.22,
          notes: '',
        }
      : null,
  );
  const [rows, setRows] = useState<VestRowDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Load the existing grant once its live data is in.
  useEffect(() => {
    if (adding || grant != null || isLoading) {
      return;
    }
    const existing = grants.find(g => g.id === id);
    if (!existing) {
      return;
    }
    setGrant({
      name: existing.name,
      ticker: existing.ticker,
      grant_date: existing.grant_date,
      total_shares: existing.total_shares,
      account: existing.account,
      category: existing.category,
      payee: existing.payee,
      withholding_rate: existing.withholding_rate,
      notes: existing.notes ?? '',
    });
    setRows(
      (eventsByGrant.get(existing.id) ?? []).map(event => ({
        key: event.id,
        id: event.id,
        vest_date: event.vest_date,
        shares: event.shares,
        actual_net: event.actual_net,
        schedule: event.schedule,
      })),
    );
  }, [adding, grant, grants, eventsByGrant, id, isLoading]);

  const price = grant ? priceByTicker.get(normalizeTicker(grant.ticker)) : null;

  function patch(changes: Partial<GrantDraft>) {
    setGrant(current => (current ? { ...current, ...changes } : current));
  }

  function applyGenerated(generated: RsuVestRow[]) {
    setRows(
      generated.map(row => ({
        key: newRowKey(),
        vest_date: row.vest_date,
        shares: row.shares,
        actual_net: null,
        schedule: null,
      })),
    );
  }

  async function onSave(close: () => void) {
    if (!grant) {
      return;
    }
    setError(null);
    if (!grant.name.trim()) {
      setError(t('Give the grant a name'));
      return;
    }
    if (!grant.payee || !grant.account) {
      setError(t('Choose the payee and the account the proceeds land in'));
      return;
    }

    const events = rows.map(row => ({
      id: row.id,
      vest_date: row.vest_date,
      shares: row.shares,
      actual_net: row.actual_net,
    }));
    const grantFields = {
      name: grant.name.trim(),
      ticker: normalizeTicker(grant.ticker),
      grant_date: grant.grant_date,
      total_shares:
        grant.total_shares > 0
          ? grant.total_shares
          : roundShares(sumShares(rows)),
      account: grant.account,
      category: grant.category || null,
      payee: grant.payee,
      withholding_rate: grant.withholding_rate,
      notes: grant.notes.trim() || null,
    };

    setIsSaving(true);
    const result = adding
      ? await sendCatch('rsu-grant/create', { grant: grantFields, events })
      : await sendCatch('rsu-grant/update', {
          grant: { id, ...grantFields },
          events,
        });
    setIsSaving(false);

    if (result.error) {
      setError(
        result.error instanceof Error
          ? result.error.message
          : t('An error occurred while saving.'),
      );
      return;
    }
    close();
  }

  return (
    <Modal name="rsu-grant-edit" containerProps={{ style: { width: 900 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={adding ? t('Add RSU grant') : t('Edit RSU grant')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          {grant == null ? (
            <View style={{ padding: 20 }}>
              <Text style={{ color: theme.pageTextSubdued }}>
                {isLoading ? t('Loading…') : t('This grant no longer exists.')}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 15 }}>
              <View
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 10,
                }}
              >
                <FormField>
                  <FormLabel title={t('Name')} htmlFor="rsu-name" />
                  <InitialFocus>
                    <Input
                      id="rsu-name"
                      value={grant.name}
                      onChangeValue={name => patch({ name })}
                    />
                  </InitialFocus>
                </FormField>
                <FormField>
                  <FormLabel title={t('Ticker')} htmlFor="rsu-ticker" />
                  <Input
                    id="rsu-ticker"
                    value={grant.ticker}
                    onChangeValue={ticker => patch({ ticker })}
                    onUpdate={ticker =>
                      patch({ ticker: normalizeTicker(ticker) })
                    }
                  />
                </FormField>
                <FormField>
                  <FormLabel title={t('Grant date')} htmlFor="rsu-grant-date" />
                  <DateSelect
                    id="rsu-grant-date"
                    value={grant.grant_date ?? ''}
                    dateFormat={dateFormat}
                    onSelect={date => patch({ grant_date: date })}
                  />
                </FormField>
                <FormField>
                  <FormLabel
                    title={t('Total shares')}
                    htmlFor="rsu-total-shares"
                  />
                  <Input
                    id="rsu-total-shares"
                    inputMode="decimal"
                    // Uncontrolled: the value is parsed when the field loses focus
                    key={`total-shares-${grant.total_shares}`}
                    defaultValue={String(grant.total_shares)}
                    onUpdate={value => {
                      const parsed = Number(value.replace(/,/g, '').trim());
                      if (Number.isFinite(parsed) && parsed >= 0) {
                        patch({ total_shares: roundShares(parsed) });
                      }
                    }}
                  />
                </FormField>
                <FormField>
                  <FormLabel
                    title={t('Tax withholding')}
                    htmlFor="rsu-withholding"
                  />
                  <PercentInput
                    id="rsu-withholding"
                    value={Math.round(grant.withholding_rate * 10000) / 100}
                    max={99}
                    onUpdatePercent={percent =>
                      patch({ withholding_rate: percent / 100 })
                    }
                  />
                </FormField>
                <FormField>
                  <FormLabel title={t('Notes')} htmlFor="rsu-notes" />
                  <Input
                    id="rsu-notes"
                    value={grant.notes}
                    onChangeValue={notes => patch({ notes })}
                  />
                </FormField>
                <FormField>
                  <FormLabel title={t('Payee')} />
                  <GenericInput
                    type="id"
                    field="payee"
                    value={grant.payee}
                    onChange={payee => patch({ payee })}
                  />
                </FormField>
                <FormField>
                  <FormLabel title={t('Deposit account')} />
                  <GenericInput
                    type="id"
                    field="account"
                    value={grant.account}
                    onChange={account => patch({ account })}
                  />
                </FormField>
                <FormField>
                  <FormLabel title={t('Income category')} />
                  <GenericInput
                    type="id"
                    field="category"
                    value={grant.category ?? ''}
                    onChange={(category: string) =>
                      patch({ category: category || null })
                    }
                  />
                </FormField>
              </View>

              <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
                <Trans>
                  Each future vest row becomes a schedule for its estimated net
                  (shares × price, less withholding). Rows in the past get no
                  schedule; record their actual net instead.
                </Trans>
              </Text>

              <VestCadenceGenerator
                totalShares={grant.total_shares}
                defaultStart={grant.grant_date ?? today}
                hasRows={rows.length > 0}
                onGenerate={applyGenerated}
              />

              <VestEventsEditor
                rows={rows}
                onChange={setRows}
                totalShares={grant.total_shares}
                priceCents={price?.price ?? null}
                withholdingRate={grant.withholding_rate}
                statusByEvent={statusByEvent}
                today={today}
              />

              {error && <Text style={{ color: theme.errorText }}>{error}</Text>}

              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: 10,
                }}
              >
                <Button onPress={() => state.close()}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  variant="primary"
                  isDisabled={isSaving}
                  onPress={() => onSave(() => state.close())}
                >
                  {adding ? t('Add') : t('Save')}
                </Button>
              </View>
            </View>
          )}
        </>
      )}
    </Modal>
  );
}
