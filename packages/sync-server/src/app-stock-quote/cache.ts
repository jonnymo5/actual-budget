import { isStockQuote } from './providers';
import type { StockQuoteResult } from './providers';

const QUOTE_TTL_MS = 15 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;

type Entry = { value: StockQuoteResult; expiresAt: number };

const cache = new Map<string, Entry>();

export function getCachedQuote(
  symbol: string,
  now: number = Date.now(),
): StockQuoteResult | null {
  const entry = cache.get(symbol);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now) {
    cache.delete(symbol);
    return null;
  }
  return entry.value;
}

export function setCachedQuote(
  symbol: string,
  value: StockQuoteResult,
  now: number = Date.now(),
): void {
  const ttl = isStockQuote(value) ? QUOTE_TTL_MS : NEGATIVE_TTL_MS;
  cache.set(symbol, { value, expiresAt: now + ttl });
}

/** For tests. */
export function clearQuoteCache(): void {
  cache.clear();
}
