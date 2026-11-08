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

function yahooHistoryBody(days: Array<[string, number]>, gmtoffset = -18000) {
  // Yahoo stamps each day with the market open in the exchange's time zone.
  const timestamp = days.map(([date]) =>
    Math.floor(new Date(`${date}T14:30:00Z`).getTime() / 1000),
  );
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD', gmtoffset },
          timestamp,
          indicators: { quote: [{ close: days.map(([, close]) => close) }] },
        },
      ],
      error: null,
    },
  };
}

function postHistory(body: object) {
  return request(app)
    .post('/history')
    .set('x-actual-token', 'valid-token')
    .send(body);
}

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

describe('/stock-quote/history', () => {
  beforeEach(() => {
    clearQuoteCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects malformed requests', async () => {
    for (const body of [
      {},
      { symbol: 'ABCD', dates: [] },
      { symbol: 'ABCD', dates: ['2025-13-01'] },
      { symbol: '../x', dates: ['2025-01-02'] },
      { symbol: 'ABCD', dates: Array.from({ length: 61 }, () => '2025-01-02') },
    ]) {
      const res = await postHistory(body);
      expect(res.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the close on each date, or the last trading day before it', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(
        200,
        yahooHistoryBody([
          ['2025-01-02', 100],
          ['2025-01-03', 101],
          ['2025-01-06', 102],
        ]),
      ),
    );

    const res = await postHistory({
      symbol: 'abcd',
      // A Friday, a Saturday (market shut) and a date before any data
      dates: ['2025-01-03', '2025-01-04', '2024-12-20'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      symbol: 'ABCD',
      currency: 'USD',
      closes: [
        { date: '2025-01-03', close: 101, close_date: '2025-01-03' },
        { date: '2025-01-04', close: 101, close_date: '2025-01-03' },
      ],
      errors: [{ date: '2024-12-20', reason: 'not-found' }],
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/chart/ABCD?period1=');
    expect(url).toContain('interval=1d');
  });

  it('reuses one fetch for the same symbol and range', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(200, yahooHistoryBody([['2025-01-02', 100]])),
    );

    await postHistory({ symbol: 'ABCD', dates: ['2025-01-02'] });
    await postHistory({ symbol: 'ABCD', dates: ['2025-01-02'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports provider failures per date without failing the request', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));

    const res = await postHistory({ symbol: 'ABCD', dates: ['2025-01-02'] });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.errors).toEqual([
      { date: '2025-01-02', reason: 'provider-error' },
    ]);
  });
});
