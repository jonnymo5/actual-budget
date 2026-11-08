import express from 'express';
import rateLimit from 'express-rate-limit';

import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import { getCachedQuote, setCachedQuote } from './cache';
import { fetchQuote, isStockQuote } from './providers';

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

app.use(errorMiddleware);
