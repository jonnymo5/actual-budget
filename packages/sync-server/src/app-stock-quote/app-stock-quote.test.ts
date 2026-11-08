import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { handlers as app } from './app-stock-quote';
import { clearQuoteCache } from './cache';

vi.mock('#util/middlewares', async () => ({
  ...(await vi.importActual('#util/middlewares')),
  requestLoggerMiddleware: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('express-rate-limit', () => ({
  default: vi.fn(
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
}));

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const STOOQ = 'https://stooq.com/q/l/';

function yahooBody(price: number, currency = 'USD', time = 1736521200) {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            currency,
            regularMarketTime: time,
          },
        },
      ],
      error: null,
    },
  };
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function textResponse(status: number, text: string) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(text),
  });
}

const fetchMock = vi.fn();

function postQuotes(symbols: unknown) {
  return request(app)
    .post('/quotes')
    .set('x-actual-token', 'valid-token')
    .send({ symbols });
}

describe('/stock-quote/quotes', () => {
  beforeEach(() => {
    clearQuoteCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a session', async () => {
    const res = await request(app)
      .post('/quotes')
      .send({ symbols: ['ABCD'] });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed symbol lists', async () => {
    for (const symbols of [
      [],
      ['../x'],
      [42],
      'ABCD',
      Array.from({ length: 21 }, (_, i) => `S${i}`),
    ]) {
      const res = await postQuotes(symbols);
      expect(res.statusCode).toBe(400);
      expect(res.body.reason).toBe('bad-request');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Yahoo quotes with upper-cased symbols', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith(YAHOO)) return jsonResponse(200, yahooBody(123.45));
      return textResponse(500, '');
    });

    const res = await postQuotes(['abcd', 'ABCD']);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      data: {
        quotes: [
          {
            symbol: 'ABCD',
            price: 123.45,
            currency: 'USD',
            asOf: '2025-01-10T15:00:00.000Z',
            source: 'yahoo',
            cached: false,
          },
        ],
        errors: [],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Stooq when Yahoo fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith(YAHOO)) return textResponse(500, 'boom');
      if (url.startsWith(STOOQ)) {
        return textResponse(
          200,
          'Symbol,Date,Time,Open,High,Low,Close,Volume\nABCD.US,2025-01-10,21:00:00,100,101,99,100.5,1000\n',
        );
      }
      return textResponse(404, '');
    });

    const res = await postQuotes(['ABCD']);

    expect(res.body.data.quotes).toEqual([
      {
        symbol: 'ABCD',
        price: 100.5,
        currency: 'USD',
        asOf: '2025-01-10T21:00:00.000Z',
        source: 'stooq',
        cached: false,
      },
    ]);
  });

  it('reports symbols neither provider knows, without failing the batch', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('GOOD')) return jsonResponse(200, yahooBody(10));
      if (url.startsWith(YAHOO)) return jsonResponse(404, {});
      return textResponse(
        200,
        'Symbol,Date,Time,Open,High,Low,Close,Volume\nNOPE.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n',
      );
    });

    const res = await postQuotes(['GOOD', 'NOPE']);

    expect(
      res.body.data.quotes.map((quote: { symbol: string }) => quote.symbol),
    ).toEqual(['GOOD']);
    expect(res.body.data.errors).toEqual([
      { symbol: 'NOPE', reason: 'not-found' },
    ]);
  });

  it('marks provider outages as provider errors', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));

    const res = await postQuotes(['ABCD']);

    expect(res.body.data.errors).toEqual([
      { symbol: 'ABCD', reason: 'provider-error' },
    ]);
  });

  it('serves repeated lookups from the cache', async () => {
    fetchMock.mockImplementation(() => jsonResponse(200, yahooBody(50)));

    await postQuotes(['ABCD']);
    const res = await postQuotes(['ABCD']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.body.data.quotes[0].cached).toBe(true);
  });
});
