import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createServer } from '#server';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { allTools } from '#tools/index';

import { MAX_REQUEST_BYTES, serveHttp } from './http';
import type { HttpAppOptions, HttpServer } from './http';

let budget: TestBudget;
const running: HttpServer[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  budget = await createTestBudget();
});

afterAll(async () => {
  await budget.dispose();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(running.splice(0).map(server => server.close()));
});

async function start(options: Partial<HttpAppOptions> = {}) {
  const server = await serveHttp({
    host: '127.0.0.1',
    port: 0,
    createMcpServer: () =>
      createServer({ session: budget.session, readOnly: false }).server,
    ...options,
  });
  running.push(server);
  return { url: `http://127.0.0.1:${server.port}`, port: server.port };
}

async function connect(url: string, headers?: Record<string, string>) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${url}/mcp`),
      headers ? { requestInit: { headers } } : undefined,
    ),
  );
  clients.push(client);
  return client;
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0.0.0' },
  },
});

// fetch cannot set the Host header, and these tests need to.
function rawRequest(
  port: number,
  {
    method = 'POST',
    path = '/mcp',
    headers = {},
    body,
  }: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('the http transport', () => {
  it('serves every tool to a real MCP client', async () => {
    const { url } = await start();
    const client = await connect(url);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(allTools.length);
    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        'get_overview',
        'parse_ofx',
        'import_transactions',
      ]),
    );

    const result = await client.callTool({ name: 'list_accounts' });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('Checking');
  });

  it('keeps no session, so any number of clients and calls work', async () => {
    const { url } = await start();
    const [first, second] = await Promise.all([connect(url), connect(url)]);

    const answers = await Promise.all([
      first.callTool({ name: 'list_accounts' }),
      second.callTool({ name: 'list_accounts' }),
      first.listTools(),
      second.callTool({ name: 'get_budget_months' }),
    ]);
    expect(answers).toHaveLength(4);
    // The same client can go on afterwards.
    expect((await first.callTool({ name: 'list_accounts' })).isError).not.toBe(
      true,
    );
  });

  it('reports a failed tool call as an MCP error, not an HTTP one', async () => {
    const { url } = await start();
    const client = await connect(url);

    const result = await client.callTool({
      name: 'reconcile_account',
      arguments: {
        account_id: 'No Such Account',
        statement_balance: 0,
        statement_date: '2026-09-30',
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/unknown account/);
  });

  it('answers /healthz without asking who is calling', async () => {
    const { port } = await start({ authToken: 'a-token-of-16-chars' });

    const response = await rawRequest(port, {
      method: 'GET',
      path: '/healthz',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('refuses GET and DELETE on /mcp, since there is no session to stream or end', async () => {
    const { port } = await start();

    for (const method of ['GET', 'DELETE']) {
      const response = await rawRequest(port, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.allow, method).toBe('POST');
    }
  });

  it('answers a malformed request body with a 400', async () => {
    const { port } = await start();

    const response = await rawRequest(port, { body: '{not json' });

    expect(response.status).toBe(400);
  });

  it('knows no other paths', async () => {
    const { port } = await start();

    expect((await rawRequest(port, { method: 'GET', path: '/' })).status).toBe(
      404,
    );
  });

  describe('with a bearer token', () => {
    const token = 'a-token-of-16-chars';

    it('lets a client with the token in', async () => {
      const { url } = await start({ authToken: token });
      const client = await connect(url, { Authorization: `Bearer ${token}` });

      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    });

    it.each([
      ['no Authorization header', undefined],
      ['the wrong token', 'Bearer not-the-right-token-at-all'],
      [
        'a token that is a prefix of the right one',
        `Bearer ${token.slice(0, 8)}`,
      ],
      ['the right token under the wrong scheme', `Basic ${token}`],
      ['an empty bearer token', 'Bearer '],
    ])('turns away %s', async (_name, authorization) => {
      const { port } = await start({ authToken: token });

      const response = await rawRequest(port, {
        headers: authorization ? { authorization } : {},
        body: initialize,
      });

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.body).not.toContain(token);
    });

    it('guards GET and DELETE too', async () => {
      const { port } = await start({ authToken: token });

      expect((await rawRequest(port, { method: 'GET' })).status).toBe(401);
      expect((await rawRequest(port, { method: 'DELETE' })).status).toBe(401);
    });

    it('does not log the token it refuses', async () => {
      const lines: string[] = [];
      const { port } = await start({
        authToken: token,
        log: line => lines.push(line),
      });

      await rawRequest(port, {
        headers: { authorization: 'Bearer secret-guess-12345' },
        body: initialize,
      });

      expect(lines).toEqual([
        'refused a POST /mcp request without a valid bearer token',
      ]);
    });
  });

  describe('the Host header', () => {
    it('must name the loopback address when listening there', async () => {
      const { port } = await start();

      const foreign = await rawRequest(port, {
        headers: { host: 'evil.example' },
        body: initialize,
      });
      const local = await rawRequest(port, {
        headers: { host: `localhost:${port}` },
        body: initialize,
      });

      expect(foreign.status).toBe(403);
      expect(local.status).toBe(200);
    });

    it('must be on the list when there is one', async () => {
      const { port } = await start({
        host: '0.0.0.0',
        allowedHosts: ['actual.example.ts.net'],
      });

      const listed = await rawRequest(port, {
        headers: { host: 'actual.example.ts.net' },
        body: initialize,
      });
      const unlisted = await rawRequest(port, {
        headers: { host: 'evil.example' },
        body: initialize,
      });
      // A container health check addresses the container by whatever name.
      const health = await rawRequest(port, {
        method: 'GET',
        path: '/healthz',
        headers: { host: 'evil.example' },
      });

      expect(listed.status).toBe(200);
      expect(unlisted.status).toBe(403);
      expect(health.status).toBe(200);
    });

    it('is not checked when listening on all interfaces without a list', async () => {
      const { port } = await start({ host: '0.0.0.0' });

      const response = await rawRequest(port, {
        headers: { host: 'anything.example' },
        body: initialize,
      });

      expect(response.status).toBe(200);
    });
  });

  describe('large requests', () => {
    it('takes a statement far bigger than the usual 100 kB body limit', async () => {
      const { url } = await start();
      const client = await connect(url);

      const result = await client.callTool({
        name: 'parse_ofx',
        arguments: { content: 'x'.repeat(2_000_000) },
      });

      // The tool ran and refused the text, so the request itself got through.
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/no <OFX> element/);
    });

    it('refuses a body over the limit', async () => {
      const { port } = await start();

      const response = await rawRequest(port, {
        body: JSON.stringify({ padding: 'x'.repeat(MAX_REQUEST_BYTES) }),
      });

      expect(response.status).toBe(413);
    });
  });

  it('stops listening when closed', async () => {
    const server = await serveHttp({
      host: '127.0.0.1',
      port: 0,
      createMcpServer: () =>
        createServer({ session: budget.session, readOnly: false }).server,
    });
    const { port } = server;

    await server.close();

    await expect(
      rawRequest(port, { method: 'GET', path: '/healthz' }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
