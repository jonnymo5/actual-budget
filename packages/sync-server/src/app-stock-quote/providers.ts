export type StockQuote = {
  symbol: string;
  /** Major currency units, e.g. 123.45 */
  price: number;
  currency: string | null;
  /** ISO timestamp of the quote, when the provider gives one */
  asOf: string | null;
  source: 'yahoo' | 'stooq';
};

export type StockQuoteError = {
  symbol: string;
  reason: 'not-found' | 'provider-error';
};

export type StockQuoteResult = StockQuote | StockQuoteError;

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>;

const USER_AGENT = 'Mozilla/5.0 (compatible; Actual Budget stock quotes)';
const TIMEOUT_MS = 8_000;

export function isStockQuote(result: StockQuoteResult): result is StockQuote {
  return 'price' in result;
}

/**
 * Yahoo Finance's public chart endpoint. Unknown symbols come back as a 404
 * (or a `chart.error` body), which we report as "not found" so the next
 * provider can try.
 */
export async function fetchYahooQuote(
  symbol: string,
  fetchImpl: FetchLike = fetch,
): Promise<StockQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Yahoo Finance responded with ${res.status}`);
  }

  const body = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: unknown;
          currency?: unknown;
          regularMarketTime?: unknown;
        };
      }> | null;
      error?: unknown;
    };
  };
  const meta = body?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    if (body?.chart?.error) {
      return null;
    }
    throw new Error('Yahoo Finance response had no price');
  }

  const time = meta?.regularMarketTime;
  return {
    symbol,
    price,
    currency: typeof meta?.currency === 'string' ? meta.currency : null,
    asOf: typeof time === 'number' ? new Date(time * 1000).toISOString() : null,
    source: 'yahoo',
  };
}

/** Parses Stooq's one-row CSV (`Symbol,Date,Time,Open,High,Low,Close,Volume`). */
export function parseStooqCsv(symbol: string, csv: string): StockQuote | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return null;
  }
  const header = lines[0].split(',').map(cell => cell.trim().toLowerCase());
  const values = lines[1].split(',').map(cell => cell.trim());
  const row = Object.fromEntries(header.map((name, i) => [name, values[i]]));

  const close = Number(row.close);
  if (!row.close || row.close === 'N/D' || !Number.isFinite(close)) {
    return null;
  }

  let asOf: string | null = null;
  if (row.date && row.date !== 'N/D') {
    const time = row.time && row.time !== 'N/D' ? row.time : '00:00:00';
    const parsed = new Date(`${row.date}T${time}Z`);
    asOf = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return { symbol, price: close, currency: 'USD', asOf, source: 'stooq' };
}

/** Stooq's CSV quote endpoint, used as a fallback. US listings only. */
export async function fetchStooqQuote(
  symbol: string,
  fetchImpl: FetchLike = fetch,
): Promise<StockQuote | null> {
  const stooqSymbol = `${symbol.toLowerCase().replace(/\./g, '-')}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Stooq responded with ${res.status}`);
  }
  return parseStooqCsv(symbol, await res.text());
}

/**
 * Tries each provider in turn. A provider that does not know the symbol
 * yields to the next one; a provider that fails outright is logged and
 * skipped. Both hosts are fixed and the symbol is validated by the caller,
 * so there is no user-controlled URL to guard against here.
 */
export async function fetchQuote(
  symbol: string,
  fetchImpl: FetchLike = fetch,
): Promise<StockQuoteResult> {
  let sawError = false;
  for (const provider of [fetchYahooQuote, fetchStooqQuote]) {
    try {
      const quote = await provider(symbol, fetchImpl);
      if (quote) {
        return quote;
      }
    } catch (error) {
      sawError = true;
      console.log(
        `Stock quote provider failed for ${symbol}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { symbol, reason: sawError ? 'provider-error' : 'not-found' };
}

export type HistoricalClose = {
  /** Trading day, YYYY-MM-DD in the exchange's local time */
  date: string;
  /** Major currency units */
  close: number;
};

export type PriceHistory = {
  symbol: string;
  currency: string | null;
  closes: HistoricalClose[];
};

function toUnixSeconds(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
}

/**
 * Daily closes between two dates (inclusive) from Yahoo Finance's chart
 * endpoint. Closes are the raw ones, not split-adjusted, which is what a vest
 * that happened on that day was worth.
 */
export async function fetchYahooHistory(
  symbol: string,
  fromDate: string,
  toDate: string,
  fetchImpl: FetchLike = fetch,
): Promise<PriceHistory | null> {
  const period1 = toUnixSeconds(fromDate);
  const period2 = toUnixSeconds(toDate) + 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Yahoo Finance responded with ${res.status}`);
  }

  const body = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: { currency?: unknown; gmtoffset?: unknown };
        timestamp?: unknown;
        indicators?: { quote?: Array<{ close?: unknown }> };
      }> | null;
      error?: unknown;
    };
  };
  const result = body?.chart?.result?.[0];
  if (!result) {
    if (body?.chart?.error) {
      return null;
    }
    throw new Error('Yahoo Finance response had no data');
  }

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const rawCloses = result.indicators?.quote?.[0]?.close;
  const closeValues = Array.isArray(rawCloses) ? rawCloses : [];
  const gmtOffset =
    typeof result.meta?.gmtoffset === 'number' ? result.meta.gmtoffset : 0;

  const closes: HistoricalClose[] = [];
  timestamps.forEach((timestamp, index) => {
    const close = closeValues[index];
    if (typeof timestamp !== 'number' || typeof close !== 'number') {
      return;
    }
    if (!Number.isFinite(close)) {
      return;
    }
    const date = new Date((timestamp + gmtOffset) * 1000)
      .toISOString()
      .slice(0, 10);
    closes.push({ date, close });
  });
  closes.sort((a, b) => a.date.localeCompare(b.date));

  return {
    symbol,
    currency:
      typeof result.meta?.currency === 'string' ? result.meta.currency : null,
    closes,
  };
}

/** The last close on or before `date`, for markets that were shut that day. */
export function closeOnOrBefore(
  closes: HistoricalClose[],
  date: string,
): HistoricalClose | null {
  let found: HistoricalClose | null = null;
  for (const close of closes) {
    if (close.date > date) {
      break;
    }
    found = close;
  }
  return found;
}
