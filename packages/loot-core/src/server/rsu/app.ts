import { v4 as uuidv4 } from 'uuid';

import * as asyncStorage from '#platform/server/asyncStorage';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { PostError } from '#server/errors';
import { mutator, runMutator } from '#server/mutators';
import { post } from '#server/post';
import * as prefs from '#server/prefs';
import {
  createSchedule,
  deleteSchedule,
  getRuleForSchedule,
  updateSchedule,
} from '#server/schedules/app';
import { getServer } from '#server/server-config';
import { updateRule } from '#server/transactions/transaction-rules';
import { undoable } from '#server/undo';
import { addDays, currentDay, subDays } from '#shared/months';
import { q } from '#shared/query';
import {
  clampWithholdingRate,
  isValidTicker,
  normalizeTicker,
  roundShares,
  rsuScheduleName,
  vestEventNet,
} from '#shared/rsu';
import { extractScheduleConds } from '#shared/schedules';
import { amountToInteger } from '#shared/util';
import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  RuleActionEntity,
  RuleConditionEntity,
  ScheduleEntity,
  StockPriceEntity,
  StockPriceSource,
} from '#types/models';

export type RsuVestEventInput = {
  id?: string;
  vest_date: string;
  shares: number;
  actual_price?: number | null;
  actual_net?: number | null;
  notes?: string | null;
};

export type RsuGrantInput = Omit<
  RsuGrantEntity,
  'id' | 'tombstone' | 'sort_order' | 'grant_date' | 'category' | 'notes'
> & {
  id?: string;
  grant_date?: string | null;
  category?: string | null;
  notes?: string | null;
  sort_order?: number | null;
};

export type RsuData = {
  grants: RsuGrantEntity[];
  events: RsuVestEventEntity[];
  prices: StockPriceEntity[];
};

export type RsuSyncResult = {
  created: string[];
  updated: string[];
  deleted: string[];
  skipped: { missingPrice: string[]; past: string[] };
};

export type RsuRefreshError =
  | 'no-server'
  | 'unauthorized'
  | 'network-failure'
  | 'unknown'
  | string;

export type RsuRefreshResult = {
  /** Tickers whose price was updated */
  updated: string[];
  failed: Array<{ symbol: string; reason: string }>;
  /** Tickers left alone (manual override, or nothing to fetch) */
  skipped: string[];
  error?: RsuRefreshError;
};

type StockQuoteResponse = {
  quotes: Array<{
    symbol: string;
    price: number;
    currency?: string | null;
    asOf?: string | null;
    source: StockPriceSource;
  }>;
  errors: Array<{ symbol: string; reason: string }>;
};

export type RsuLockResult = {
  /** Vest event ids whose price was locked */
  locked: string[];
  failed: Array<{ eventId: string; reason: string }>;
  error?: RsuRefreshError;
};

export type RsuMatchResult = {
  matched: Array<{ eventId: string; transactionId: string; amount: number }>;
  unmatched: string[];
};

type StockHistoryResponse = {
  symbol: string;
  currency: string | null;
  closes: Array<{ date: string; close: number; close_date: string }>;
  errors: Array<{ date: string; reason: string }>;
};

export type RsuHandlers = {
  'rsu/get': typeof getRsuData;
  'rsu/lock-vest-prices': typeof lockVestPrices;
  'rsu/match-deposits': typeof matchDeposits;
  'rsu-grant/create': typeof createGrant;
  'rsu-grant/update': typeof updateGrant;
  'rsu-grant/delete': typeof deleteGrant;
  'rsu-vest-event/create': typeof createVestEvent;
  'rsu-vest-event/update': typeof updateVestEvent;
  'rsu-vest-event/delete': typeof deleteVestEvent;
  'rsu/set-price': typeof setPrice;
  'rsu/refresh-prices': typeof refreshPrices;
  'rsu/sync-schedules': typeof syncSchedules;
};

export const app = createApp<RsuHandlers>();
app.method('rsu/get', getRsuData);
app.method('rsu-grant/create', mutator(undoable(createGrant)));
app.method('rsu-grant/update', mutator(undoable(updateGrant)));
app.method('rsu-grant/delete', mutator(undoable(deleteGrant)));
app.method('rsu-vest-event/create', mutator(undoable(createVestEvent)));
app.method('rsu-vest-event/update', mutator(undoable(updateVestEvent)));
app.method('rsu-vest-event/delete', mutator(undoable(deleteVestEvent)));
app.method('rsu/set-price', mutator(undoable(setPrice)));
app.method('rsu/refresh-prices', mutator(refreshPrices));
app.method('rsu/lock-vest-prices', mutator(lockVestPrices));
app.method('rsu/match-deposits', mutator(undoable(matchDeposits)));
app.method('rsu/sync-schedules', mutator(undoable(syncSchedules)));

// Reads

async function getGrants(): Promise<RsuGrantEntity[]> {
  const { data } = await aqlQuery(q('rsu_grants').select('*'));
  return data as RsuGrantEntity[];
}

async function getGrant(id: string): Promise<RsuGrantEntity | null> {
  const { data } = await aqlQuery(q('rsu_grants').filter({ id }).select('*'));
  return (data as RsuGrantEntity[])[0] ?? null;
}

async function getEvents(grantId?: string): Promise<RsuVestEventEntity[]> {
  let query = q('rsu_vest_events').select('*');
  if (grantId) {
    query = query.filter({ grant_id: grantId });
  }
  const { data } = await aqlQuery(query);
  return data as RsuVestEventEntity[];
}

async function getPrices(): Promise<StockPriceEntity[]> {
  const { data } = await aqlQuery(q('stock_prices').select('*'));
  return data as StockPriceEntity[];
}

async function getPrice(ticker: string): Promise<StockPriceEntity | null> {
  const { data } = await aqlQuery(
    q('stock_prices')
      .filter({ id: normalizeTicker(ticker) })
      .select('*'),
  );
  return (data as StockPriceEntity[])[0] ?? null;
}

async function getScheduleEntity(id: string): Promise<ScheduleEntity | null> {
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  return (data as ScheduleEntity[])[0] ?? null;
}

export async function getRsuData(): Promise<RsuData> {
  const [grants, events, prices] = await Promise.all([
    getGrants(),
    getEvents(),
    getPrices(),
  ]);
  return { grants, events, prices };
}

// Validation

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateGrant(
  grant: Partial<RsuGrantInput>,
  { update = false }: { update?: boolean } = {},
) {
  if (!update || grant.name !== undefined) {
    if (!grant.name?.trim()) {
      throw new Error('A grant name is required');
    }
  }
  if (!update || grant.ticker !== undefined) {
    if (!isValidTicker(normalizeTicker(grant.ticker ?? ''))) {
      throw new Error('Enter a valid ticker symbol');
    }
  }
  if (!update || grant.account !== undefined) {
    if (!grant.account) {
      throw new Error('A deposit account is required');
    }
  }
  if (!update || grant.payee !== undefined) {
    if (!grant.payee) {
      throw new Error('A payee is required');
    }
  }
  if (grant.grant_date != null && !ISO_DATE_RE.test(grant.grant_date)) {
    throw new Error('The grant date is not valid');
  }
  if (
    grant.withholding_rate != null &&
    (Number.isNaN(grant.withholding_rate) ||
      grant.withholding_rate < 0 ||
      grant.withholding_rate >= 1)
  ) {
    throw new Error('Withholding must be between 0% and 99%');
  }
  if (grant.total_shares != null && !(grant.total_shares >= 0)) {
    throw new Error('Total shares must be zero or more');
  }
}

function validateEvent(event: RsuVestEventInput) {
  if (!ISO_DATE_RE.test(event.vest_date ?? '')) {
    throw new Error('Each vest row needs a date');
  }
  if (!(event.shares > 0)) {
    throw new Error('Each vest row needs a positive share count');
  }
}

// Row builders

function grantRow(grant: Partial<RsuGrantInput>) {
  const row: Record<string, unknown> = {};
  if (grant.name !== undefined) row.name = grant.name.trim();
  if (grant.ticker !== undefined) row.ticker = normalizeTicker(grant.ticker);
  if (grant.grant_date !== undefined) row.grant_date = grant.grant_date;
  if (grant.total_shares !== undefined) {
    row.total_shares = roundShares(grant.total_shares);
  }
  if (grant.account !== undefined) row.account = grant.account;
  if (grant.category !== undefined) row.category = grant.category;
  if (grant.payee !== undefined) row.payee = grant.payee;
  if (grant.withholding_rate !== undefined) {
    row.withholding_rate = clampWithholdingRate(grant.withholding_rate);
  }
  if (grant.notes !== undefined) row.notes = grant.notes;
  if (grant.sort_order !== undefined) row.sort_order = grant.sort_order;
  return row;
}

function eventRow(event: Partial<RsuVestEventInput>) {
  const row: Record<string, unknown> = {};
  if (event.vest_date !== undefined) row.vest_date = event.vest_date;
  if (event.shares !== undefined) row.shares = roundShares(event.shares);
  if (event.actual_price !== undefined) row.actual_price = event.actual_price;
  if (event.actual_net !== undefined) row.actual_net = event.actual_net;
  if (event.notes !== undefined) row.notes = event.notes;
  return row;
}

async function insertEventRow(grantId: string, event: RsuVestEventInput) {
  const id = event.id || uuidv4();
  await db.insertWithSchema('rsu_vest_events', {
    ...eventRow(event),
    id,
    grant_id: grantId,
    schedule: null,
    tombstone: false,
  });
  return id;
}

/** Deletes a vest event together with its schedule, unless that was paid. */
async function removeEventRow(event: RsuVestEventEntity) {
  if (event.schedule) {
    const schedule = await getScheduleEntity(event.schedule);
    if (schedule && !schedule.completed) {
      await deleteSchedule({ id: schedule.id });
    }
  }
  await db.delete_('rsu_vest_events', event.id);
}

// Grants

export async function createGrant({
  grant,
  events = [],
}: {
  grant: RsuGrantInput;
  events?: RsuVestEventInput[];
}): Promise<RsuGrantEntity['id']> {
  validateGrant(grant);
  events.forEach(validateEvent);

  const id = grant.id || uuidv4();
  await db.insertWithSchema('rsu_grants', {
    ...grantRow(grant),
    id,
    tombstone: false,
  });
  for (const event of events) {
    await insertEventRow(id, event);
  }
  await syncSchedulesForGrant(id);
  return id;
}

export async function updateGrant({
  grant,
  events,
}: {
  grant: Partial<RsuGrantInput> & Pick<RsuGrantEntity, 'id'>;
  /** When given, the full desired list of vest rows for the grant. */
  events?: RsuVestEventInput[];
}): Promise<RsuGrantEntity['id']> {
  const existing = await getGrant(grant.id);
  if (!existing) {
    throw new Error('RSU grant not found');
  }
  validateGrant(grant, { update: true });

  const row = grantRow(grant);
  if (Object.keys(row).length > 0) {
    await db.updateWithSchema('rsu_grants', { id: grant.id, ...row });
  }

  if (events) {
    events.forEach(validateEvent);
    const current = await getEvents(grant.id);
    const desiredIds = new Set(
      events.map(event => event.id).filter((id): id is string => !!id),
    );
    for (const old of current) {
      if (!desiredIds.has(old.id)) {
        await removeEventRow(old);
      }
    }
    for (const event of events) {
      if (event.id && current.some(old => old.id === event.id)) {
        await db.updateWithSchema('rsu_vest_events', {
          id: event.id,
          ...eventRow(event),
        });
      } else {
        await insertEventRow(grant.id, event);
      }
    }
  }

  await syncSchedulesForGrant(grant.id);
  return grant.id;
}

export async function deleteGrant({
  id,
}: Pick<RsuGrantEntity, 'id'>): Promise<RsuGrantEntity['id']> {
  const events = await getEvents(id);
  for (const event of events) {
    await removeEventRow(event);
  }
  await db.delete_('rsu_grants', id);
  return id;
}

// Vest events

export async function createVestEvent({
  grant_id,
  ...event
}: RsuVestEventInput & { grant_id: string }): Promise<
  RsuVestEventEntity['id']
> {
  const grant = await getGrant(grant_id);
  if (!grant) {
    throw new Error('RSU grant not found');
  }
  validateEvent(event);
  const id = await insertEventRow(grant_id, event);
  await syncSchedulesForGrant(grant_id);
  return id;
}

export async function updateVestEvent(
  event: Partial<RsuVestEventInput> & Pick<RsuVestEventEntity, 'id'>,
): Promise<RsuVestEventEntity['id']> {
  const { data } = await aqlQuery(
    q('rsu_vest_events').filter({ id: event.id }).select('*'),
  );
  const existing = (data as RsuVestEventEntity[])[0];
  if (!existing) {
    throw new Error('Vest event not found');
  }
  validateEvent({ ...existing, ...event });
  const row = eventRow(event);
  if (Object.keys(row).length > 0) {
    await db.updateWithSchema('rsu_vest_events', { id: event.id, ...row });
  }
  await syncSchedulesForGrant(existing.grant_id);
  return event.id;
}

export async function deleteVestEvent({
  id,
}: Pick<RsuVestEventEntity, 'id'>): Promise<RsuVestEventEntity['id']> {
  const { data } = await aqlQuery(
    q('rsu_vest_events').filter({ id }).select('*'),
  );
  const existing = (data as RsuVestEventEntity[])[0];
  if (existing) {
    await removeEventRow(existing);
    await syncSchedulesForGrant(existing.grant_id);
  }
  return id;
}

// Prices

async function upsertPrice(
  ticker: string,
  fields: Partial<Omit<StockPriceEntity, 'id' | 'tombstone'>>,
) {
  const id = normalizeTicker(ticker);
  const existing = await db.first<Pick<db.DbStockPrice, 'id'>>(
    'SELECT id FROM stock_prices WHERE id = ?',
    [id],
  );
  if (existing) {
    await db.updateWithSchema('stock_prices', {
      id,
      ...fields,
      tombstone: false,
    });
  } else {
    await db.insertWithSchema('stock_prices', {
      id,
      ...fields,
      tombstone: false,
    });
  }
}

async function syncGrantsForTicker(ticker: string) {
  const id = normalizeTicker(ticker);
  const grants = await getGrants();
  for (const grant of grants) {
    if (normalizeTicker(grant.ticker) === id) {
      await syncSchedulesForGrant(grant.id);
    }
  }
}

export async function setPrice({
  ticker,
  price,
  currency,
  manual_override = true,
}: {
  ticker: string;
  /** Integer cents. Omit to only change the override flag. */
  price?: number;
  currency?: string | null;
  manual_override?: boolean;
}): Promise<void> {
  const id = normalizeTicker(ticker);
  if (!isValidTicker(id)) {
    throw new Error('Enter a valid ticker symbol');
  }
  if (price != null && !(Number.isInteger(price) && price >= 0)) {
    throw new Error('The price must be zero or more');
  }

  const now = new Date().toISOString();
  const fields: Partial<Omit<StockPriceEntity, 'id' | 'tombstone'>> = {
    manual_override,
  };
  if (price != null) {
    fields.price = price;
    fields.as_of = now;
    fields.updated_at = now;
    fields.source = 'manual';
    if (currency !== undefined) {
      fields.currency = currency;
    }
  }

  await upsertPrice(id, fields);
  if (price != null) {
    await syncGrantsForTicker(id);
  }
}

async function activeTickers(): Promise<string[]> {
  const grants = await getGrants();
  return [...new Set(grants.map(grant => normalizeTicker(grant.ticker)))];
}

export async function refreshPrices({
  tickers,
  force = false,
}: {
  tickers?: string[];
  /** Also refresh tickers that have a manual override. */
  force?: boolean;
} = {}): Promise<RsuRefreshResult> {
  const wanted = (tickers ?? (await activeTickers())).map(normalizeTicker);
  const prices = await getPrices();
  const skipped: string[] = [];
  const toFetch: string[] = [];
  for (const ticker of wanted) {
    const existing = prices.find(price => price.id === ticker);
    if (!force && existing?.manual_override) {
      skipped.push(ticker);
    } else if (isValidTicker(ticker)) {
      toFetch.push(ticker);
    } else {
      skipped.push(ticker);
    }
  }

  if (toFetch.length === 0) {
    return { updated: [], failed: [], skipped };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    return {
      updated: [],
      failed: [],
      skipped: [...skipped, ...toFetch],
      error: 'no-server',
    };
  }
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return {
      updated: [],
      failed: [],
      skipped: [...skipped, ...toFetch],
      error: 'unauthorized',
    };
  }

  let response: StockQuoteResponse;
  try {
    response = (await post(
      serverConfig.BASE_SERVER + '/stock-quote/quotes',
      { symbols: toFetch },
      { 'X-ACTUAL-TOKEN': userToken },
      20_000,
    )) as StockQuoteResponse;
  } catch (error) {
    logger.warn('Stock quote refresh failed', error);
    return {
      updated: [],
      failed: [],
      skipped: [...skipped, ...toFetch],
      error: error instanceof PostError ? error.reason : 'unknown',
    };
  }

  const now = new Date().toISOString();
  const updated: string[] = [];
  for (const quote of response?.quotes ?? []) {
    const symbol = normalizeTicker(quote.symbol);
    if (!toFetch.includes(symbol) || typeof quote.price !== 'number') {
      continue;
    }
    await upsertPrice(symbol, {
      price: amountToInteger(quote.price),
      currency: quote.currency ?? null,
      as_of: quote.asOf ?? now,
      updated_at: now,
      source: quote.source ?? 'yahoo',
      manual_override: false,
    });
    updated.push(symbol);
  }
  for (const symbol of updated) {
    await syncGrantsForTicker(symbol);
  }

  const failed = (response?.errors ?? []).map(error => ({
    symbol: normalizeTicker(error.symbol),
    reason: error.reason,
  }));
  return { updated, failed, skipped };
}

// Vest-date prices

async function fetchServerJson<T>(
  path: string,
  body: unknown,
): Promise<{ data: T } | { error: RsuRefreshError }> {
  const serverConfig = getServer();
  if (!serverConfig) {
    return { error: 'no-server' };
  }
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'unauthorized' };
  }
  try {
    const data = (await post(
      serverConfig.BASE_SERVER + path,
      body,
      { 'X-ACTUAL-TOKEN': userToken },
      20_000,
    )) as T;
    return { data };
  } catch (error) {
    logger.warn(`Request to ${path} failed`, error);
    return { error: error instanceof PostError ? error.reason : 'unknown' };
  }
}

/**
 * Freeze the share price of every vest that has already happened, using the
 * close on its vest date, so past rows stop moving with the current quote.
 * Rows that already have a price are left alone.
 */
export async function lockVestPrices({
  grantId,
}: { grantId?: string } = {}): Promise<RsuLockResult> {
  const result: RsuLockResult = { locked: [], failed: [] };
  const today = currentDay();
  const grants = grantId
    ? [await getGrant(grantId)].filter((g): g is RsuGrantEntity => g != null)
    : await getGrants();
  const events = await getEvents(grantId);

  const byTicker = new Map<string, RsuVestEventEntity[]>();
  for (const event of events) {
    if (event.actual_price != null || event.vest_date > today) {
      continue;
    }
    const grant = grants.find(g => g.id === event.grant_id);
    if (!grant) {
      continue;
    }
    const ticker = normalizeTicker(grant.ticker);
    if (!isValidTicker(ticker)) {
      result.failed.push({ eventId: event.id, reason: 'invalid-ticker' });
      continue;
    }
    byTicker.set(ticker, [...(byTicker.get(ticker) ?? []), event]);
  }
  if (byTicker.size === 0) {
    return result;
  }

  for (const [ticker, tickerEvents] of byTicker) {
    const dates = [...new Set(tickerEvents.map(event => event.vest_date))];
    const response = await fetchServerJson<StockHistoryResponse>(
      '/stock-quote/history',
      { symbol: ticker, dates },
    );
    if ('error' in response) {
      result.error = response.error;
      for (const event of tickerEvents) {
        result.failed.push({ eventId: event.id, reason: response.error });
      }
      continue;
    }
    const closeByDate = new Map(
      response.data.closes.map(close => [close.date, close.close] as const),
    );
    const reasonByDate = new Map(
      response.data.errors.map(error => [error.date, error.reason] as const),
    );
    for (const event of tickerEvents) {
      const close = closeByDate.get(event.vest_date);
      if (typeof close !== 'number') {
        result.failed.push({
          eventId: event.id,
          reason: reasonByDate.get(event.vest_date) ?? 'not-found',
        });
        continue;
      }
      await db.updateWithSchema('rsu_vest_events', {
        id: event.id,
        actual_price: amountToInteger(close),
      });
      result.locked.push(event.id);
    }
  }

  // A locked price changes the amount of any schedule still open for the row.
  const touchedGrants = new Set(
    events
      .filter(event => result.locked.includes(event.id))
      .map(event => event.grant_id),
  );
  for (const id of touchedGrants) {
    await syncSchedulesForGrant(id);
  }
  return result;
}

/** How long after a vest its deposit is still accepted as a match. */
const DEPOSIT_WINDOW_AFTER_DAYS = 10;
const DEPOSIT_WINDOW_BEFORE_DAYS = 2;

/**
 * Pair past vest rows that have no recorded net with the deposit from the
 * grant's payee that landed closest to the vest date, and record its amount.
 */
export async function matchDeposits({
  grantId,
}: {
  grantId: string;
}): Promise<RsuMatchResult> {
  const result: RsuMatchResult = { matched: [], unmatched: [] };
  const grant = await getGrant(grantId);
  if (!grant) {
    throw new Error('RSU grant not found');
  }
  const today = currentDay();
  const events = (await getEvents(grantId)).filter(
    event => event.actual_net == null && event.vest_date < today,
  );
  if (events.length === 0) {
    return result;
  }

  const dates = events.map(event => event.vest_date).sort();
  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        account: grant.account,
        payee: grant.payee,
        amount: { $gt: 0 },
        date: {
          $gte: subDays(dates[0], DEPOSIT_WINDOW_BEFORE_DAYS),
          $lte: addDays(dates[dates.length - 1], DEPOSIT_WINDOW_AFTER_DAYS),
        },
      })
      .select(['id', 'date', 'amount']),
  );
  const deposits = data as Array<{ id: string; date: string; amount: number }>;
  const usedTransactions = new Set<string>();

  for (const event of events) {
    const earliest = subDays(event.vest_date, DEPOSIT_WINDOW_BEFORE_DAYS);
    const latest = addDays(event.vest_date, DEPOSIT_WINDOW_AFTER_DAYS);
    const candidates = deposits
      .filter(
        deposit =>
          !usedTransactions.has(deposit.id) &&
          deposit.date >= earliest &&
          deposit.date <= latest,
      )
      .sort(
        (a, b) =>
          Math.abs(dayDistance(a.date, event.vest_date)) -
          Math.abs(dayDistance(b.date, event.vest_date)),
      );
    const deposit = candidates[0];
    if (!deposit) {
      result.unmatched.push(event.id);
      continue;
    }
    usedTransactions.add(deposit.id);
    await db.updateWithSchema('rsu_vest_events', {
      id: event.id,
      actual_net: deposit.amount,
    });
    result.matched.push({
      eventId: event.id,
      transactionId: deposit.id,
      amount: deposit.amount,
    });
  }
  return result;
}

function dayDistance(a: string, b: string): number {
  return (
    (new Date(`${a}T00:00:00Z`).getTime() -
      new Date(`${b}T00:00:00Z`).getTime()) /
    86_400_000
  );
}

// Schedules

function conditionsFor(
  grant: RsuGrantEntity,
  event: RsuVestEventEntity,
  net: number,
): RuleConditionEntity[] {
  return [
    { op: 'is', field: 'payee', value: grant.payee },
    { op: 'is', field: 'account', value: grant.account },
    { op: 'isapprox', field: 'date', value: event.vest_date },
    { op: 'isapprox', field: 'amount', value: net },
  ];
}

async function uniqueScheduleName(
  grantName: string,
  vestDate: string,
  ownScheduleId: string | null,
): Promise<string> {
  for (let dupIndex = 0; ; dupIndex++) {
    const name = rsuScheduleName(grantName, vestDate, dupIndex);
    const taken = await db.first<Pick<db.DbSchedule, 'id'>>(
      'SELECT id FROM schedules WHERE tombstone = 0 AND name = ?',
      [name],
    );
    if (!taken || taken.id === ownScheduleId) {
      return name;
    }
  }
}

function findCategoryAction(actions: RuleActionEntity[] | null | undefined) {
  return (actions ?? []).find(
    action => action.op === 'set' && action.field === 'category',
  );
}

async function ensureCategoryAction(
  scheduleId: string,
  category: string | null,
) {
  const rule = await getRuleForSchedule(scheduleId);
  if (!rule) {
    return;
  }
  const actions = rule.serialize().actions as RuleActionEntity[];
  const existing = findCategoryAction(actions);
  const existingValue =
    existing && 'value' in existing ? (existing.value as string) : null;
  if ((existingValue ?? null) === (category ?? null)) {
    return;
  }
  const others = actions.filter(action => action !== existing);
  const wanted: RuleActionEntity[] = category
    ? [...others, { op: 'set', field: 'category', value: category }]
    : others;
  await updateRule({ id: rule.id, actions: wanted });
}

function scheduleNeedsUpdate(
  schedule: ScheduleEntity,
  name: string,
  conditions: RuleConditionEntity[],
  category: string | null,
): boolean {
  if ((schedule.name ?? null) !== name) {
    return true;
  }
  const current = extractScheduleConds(schedule._conditions ?? []);
  const wanted = extractScheduleConds(conditions);
  const differs = (
    left: { op: string; value: unknown } | null,
    right: { op: string; value: unknown } | null,
  ) =>
    (left?.op ?? null) !== (right?.op ?? null) ||
    JSON.stringify(left?.value ?? null) !==
      JSON.stringify(right?.value ?? null);
  if (
    differs(current.payee, wanted.payee) ||
    differs(current.account, wanted.account) ||
    differs(current.date, wanted.date) ||
    differs(current.amount, wanted.amount)
  ) {
    return true;
  }
  const action = findCategoryAction(schedule._actions);
  const currentCategory =
    action && 'value' in action ? ((action.value as string) ?? null) : null;
  return currentCategory !== (category ?? null);
}

/**
 * Make the one-off schedules for a grant match its vest rows: create missing
 * ones for future rows, update stale ones, and drop those whose row is gone.
 * Schedules that were already paid (completed) are left alone, as are rows in
 * the past and rows whose ticker has no price yet.
 *
 * Calls run sequentially and never inside `batchMessages`, because reads in a
 * batch would not see the writes made earlier in the same batch.
 */
export async function syncSchedulesForGrant(
  grantId: string,
): Promise<RsuSyncResult> {
  const result: RsuSyncResult = {
    created: [],
    updated: [],
    deleted: [],
    skipped: { missingPrice: [], past: [] },
  };

  const grant = await getGrant(grantId);
  if (!grant) {
    return result;
  }
  const events = await getEvents(grantId);
  const price = await getPrice(grant.ticker);
  const today = currentDay();

  for (const event of events) {
    const net = vestEventNet(event, grant, price);

    let schedule: ScheduleEntity | null = null;
    if (event.schedule) {
      schedule = await getScheduleEntity(event.schedule);
      if (!schedule) {
        await db.updateWithSchema('rsu_vest_events', {
          id: event.id,
          schedule: null,
        });
      }
    }

    if (schedule) {
      if (schedule.completed || net == null) {
        continue;
      }
      const name = await uniqueScheduleName(
        grant.name,
        event.vest_date,
        schedule.id,
      );
      const conditions = conditionsFor(grant, event, net);
      if (scheduleNeedsUpdate(schedule, name, conditions, grant.category)) {
        await updateSchedule({
          schedule: { id: schedule.id, name },
          conditions,
        });
        await ensureCategoryAction(schedule.id, grant.category);
        result.updated.push(schedule.id);
      }
      continue;
    }

    if (net == null) {
      result.skipped.missingPrice.push(event.id);
      continue;
    }
    if (event.vest_date < today) {
      result.skipped.past.push(event.id);
      continue;
    }

    const name = await uniqueScheduleName(grant.name, event.vest_date, null);
    const scheduleId = await createSchedule({
      schedule: { id: uuidv4(), name, posts_transaction: false },
      conditions: conditionsFor(grant, event, net),
    });
    await ensureCategoryAction(scheduleId, grant.category);
    await db.updateWithSchema('rsu_vest_events', {
      id: event.id,
      schedule: scheduleId,
    });
    result.created.push(scheduleId);
  }

  // Rows deleted elsewhere (another device, an older client) may still point
  // at a schedule; drop it unless it was paid.
  const orphans = await db.all<Pick<db.DbRsuVestEvent, 'id' | 'schedule'>>(
    'SELECT id, schedule FROM rsu_vest_events WHERE grant_id = ? AND tombstone = 1 AND schedule IS NOT NULL',
    [grantId],
  );
  for (const orphan of orphans) {
    const schedule = orphan.schedule
      ? await getScheduleEntity(orphan.schedule)
      : null;
    if (schedule && !schedule.completed) {
      await deleteSchedule({ id: schedule.id });
      result.deleted.push(schedule.id);
    }
    await db.update('rsu_vest_events', { id: orphan.id, schedule: null });
  }

  return result;
}

export async function syncSchedules({
  grantId,
}: { grantId?: string } = {}): Promise<RsuSyncResult> {
  const ids = grantId ? [grantId] : (await getGrants()).map(grant => grant.id);
  const total: RsuSyncResult = {
    created: [],
    updated: [],
    deleted: [],
    skipped: { missingPrice: [], past: [] },
  };
  for (const id of ids) {
    const result = await syncSchedulesForGrant(id);
    total.created.push(...result.created);
    total.updated.push(...result.updated);
    total.deleted.push(...result.deleted);
    total.skipped.missingPrice.push(...result.skipped.missingPrice);
    total.skipped.past.push(...result.skipped.past);
  }
  return total;
}

// Refresh prices once a day, after the first successful sync of the day.
app.events.on('sync', ({ type }) => {
  if (type !== 'success' || !prefs.getPrefs() || !db.getDatabase()) {
    return;
  }
  const { lastRsuPriceRefresh } = prefs.getPrefs();
  if (lastRsuPriceRefresh === currentDay()) {
    return;
  }

  void runMutator(async () => {
    // The budget may have been closed while this waited its turn.
    if (!db.getDatabase() || !getServer()) {
      return;
    }
    try {
      const hasGrants = await db.first<{ id: string }>(
        'SELECT id FROM rsu_grants WHERE tombstone = 0 LIMIT 1',
      );
      if (!hasGrants) {
        return;
      }
      const result = await refreshPrices({});
      const lock = await lockVestPrices({});
      if (!result.error && !lock.error) {
        await prefs.savePrefs({ lastRsuPriceRefresh: currentDay() });
      }
    } catch (error) {
      logger.warn('Daily stock price refresh failed', error);
    }
  });
});
