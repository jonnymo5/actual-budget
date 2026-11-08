import express from 'express';
import rateLimit from 'express-rate-limit';

import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import {
  getCachedHistory,
  getCachedQuote,
  setCachedHistory,
  setCachedQuote,
} from './cache';
import {
  closeOnOrBefore,
  fetchQuote,
  fetchYahooHistory,
  isStockQuote,
} from './providers';

const app = express();
export { app as handlers };

app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(validateSessionMiddleware);

export const quoteRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  legacyHeaders: false,
  standardHeaders: true,
  message: { status: 'error', reason: 'too-many-requests' },
});
app.use(quoteRateLimiter);

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,12}$/;
const MAX_SYMBOLS = 20;

function parseSymbols(input: unknown): string[] | null {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_SYMBOLS
  ) {
    return null;
  }
  const symbols = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return null;
    }
    const symbol = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      return null;
    }
    symbols.add(symbol);
  }
  return [...symbols];
}

/**
 * POST /stock-quote/quotes { symbols: string[] }
 *
 * Looks each symbol up (cached for 15 minutes) and answers with the quotes it
 * found and the symbols it could not price. One bad symbol never fails the
 * whole batch.
 */
app.post('/quotes', async (req, res) => {
  const symbols = parseSymbols(req.body?.symbols);
  if (!symbols) {
    res.status(400).send({
      status: 'error',
      reason: 'bad-request',
      details: `symbols must be 1 to ${MAX_SYMBOLS} ticker symbols`,
    });
    return;
  }

  const results = await Promise.all(
    symbols.map(async symbol => {
      const cached = getCachedQuote(symbol);
      if (cached) {
        return { ...cached, cached: true };
      }
      const result = await fetchQuote(symbol);
      setCachedQuote(symbol, result);
      return { ...result, cached: false };
    }),
  );

  const quotes = [];
  const errors = [];
  for (const result of results) {
    if (isStockQuote(result)) {
      quotes.push(result);
    } else {
      errors.push({ symbol: result.symbol, reason: result.reason });
    }
  }

  res.send({ status: 'ok', data: { quotes, errors } });
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DATES = 60;
/** Days of history fetched before the earliest date, to cover holidays. */
const LOOKBACK_DAYS = 10;

function parseDates(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_DATES) {
    return null;
  }
  const dates = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) {
      return null;
    }
    if (Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) {
      return null;
    }
    dates.add(raw);
  }
  return [...dates].sort();
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * POST /stock-quote/history { symbol: string, dates: string[] }
 *
 * The closing price on each date, or on the last trading day before it when
 * the market was shut. Used to lock the value of a vest that already happened.
 */
app.post('/history', async (req, res) => {
  const symbols = parseSymbols([req.body?.symbol]);
  const dates = parseDates(req.body?.dates);
  if (!symbols || !dates) {
    res.status(400).send({
      status: 'error',
      reason: 'bad-request',
      details: `symbol must be a ticker and dates 1 to ${MAX_DATES} YYYY-MM-DD dates`,
    });
    return;
  }
  const [symbol] = symbols;
  const today = new Date().toISOString().slice(0, 10);
  const from = shiftDays(dates[0], -LOOKBACK_DAYS);
  const to = dates[dates.length - 1] < today ? dates[dates.length - 1] : today;
  const cacheKey = `${symbol}|${from}|${to}`;

  let history = getCachedHistory(cacheKey);
  if (!history) {
    try {
      history = await fetchYahooHistory(symbol, from, to);
    } catch (error) {
      console.log(
        `Stock history lookup failed for ${symbol}:`,
        error instanceof Error ? error.message : error,
      );
      res.send({
        status: 'ok',
        data: {
          symbol,
          currency: null,
          closes: [],
          errors: dates.map(date => ({ date, reason: 'provider-error' })),
        },
      });
      return;
    }
    if (!history) {
      res.send({
        status: 'ok',
        data: {
          symbol,
          currency: null,
          closes: [],
          errors: dates.map(date => ({ date, reason: 'not-found' })),
        },
      });
      return;
    }
    setCachedHistory(cacheKey, history);
  }

  const closes = [];
  const errors = [];
  for (const date of dates) {
    if (date > today) {
      errors.push({ date, reason: 'in-future' });
      continue;
    }
    const close = closeOnOrBefore(history.closes, date);
    if (close) {
      closes.push({ date, close: close.close, close_date: close.date });
    } else {
      errors.push({ date, reason: 'not-found' });
    }
  }

  res.send({
    status: 'ok',
    data: { symbol, currency: history.currency, closes, errors },
  });
});

app.use(errorMiddleware);
