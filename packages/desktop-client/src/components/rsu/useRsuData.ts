import { useMemo } from 'react';

import { currentDay } from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import { normalizeTicker } from '@actual-app/core/shared/rsu';
import type { ScheduleStatusType } from '@actual-app/core/shared/schedules';
import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '@actual-app/core/types/models';

import { useQuery } from '#hooks/useQuery';
import { useSchedules } from '#hooks/useSchedules';

export type VestStatus =
  | ScheduleStatusType
  | 'recorded'
  | 'past'
  | 'needs-price'
  | 'pending';

export function getVestStatus({
  event,
  scheduleStatus,
  hasPrice,
  today,
}: {
  event: Pick<RsuVestEventEntity, 'vest_date' | 'actual_net' | 'schedule'>;
  scheduleStatus: ScheduleStatusType | undefined;
  hasPrice: boolean;
  today: string;
}): VestStatus {
  if (event.actual_net != null) {
    return 'recorded';
  }
  if (event.schedule && scheduleStatus) {
    return scheduleStatus;
  }
  if (event.vest_date < today) {
    return 'past';
  }
  if (!hasPrice) {
    return 'needs-price';
  }
  return 'pending';
}

export function useRsuData() {
  const { data: grants, isLoading: isGrantsLoading } = useQuery<RsuGrantEntity>(
    () => q('rsu_grants').select('*'),
    [],
  );
  const { data: events, isLoading: isEventsLoading } =
    useQuery<RsuVestEventEntity>(() => q('rsu_vest_events').select('*'), []);
  const { data: prices, isLoading: isPricesLoading } =
    useQuery<StockPriceEntity>(() => q('stock_prices').select('*'), []);

  const schedulesQuery = useMemo(() => q('schedules').select('*'), []);
  const { statuses: scheduleStatuses } = useSchedules({
    query: schedulesQuery,
  });

  const eventsByGrant = useMemo(() => {
    const map = new Map<string, RsuVestEventEntity[]>();
    for (const event of events ?? []) {
      const list = map.get(event.grant_id) ?? [];
      list.push(event);
      map.set(event.grant_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.vest_date.localeCompare(b.vest_date));
    }
    return map;
  }, [events]);

  const priceByTicker = useMemo(
    () =>
      new Map(
        (prices ?? []).map(
          price => [normalizeTicker(price.id), price] as const,
        ),
      ),
    [prices],
  );

  const today = currentDay();
  const statusByEvent = useMemo(() => {
    const map = new Map<string, VestStatus>();
    for (const event of events ?? []) {
      const grant = (grants ?? []).find(g => g.id === event.grant_id);
      const hasPrice = grant
        ? priceByTicker.has(normalizeTicker(grant.ticker))
        : false;
      map.set(
        event.id,
        getVestStatus({
          event,
          scheduleStatus: event.schedule
            ? scheduleStatuses.get(event.schedule)
            : undefined,
          hasPrice,
          today,
        }),
      );
    }
    return map;
  }, [events, grants, priceByTicker, scheduleStatuses, today]);

  return {
    isLoading: isGrantsLoading || isEventsLoading || isPricesLoading,
    grants: grants ?? [],
    events: events ?? [],
    prices: prices ?? [],
    eventsByGrant,
    priceByTicker,
    statusByEvent,
    today,
  };
}
