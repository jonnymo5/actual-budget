import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Express, RequestHandler, Response } from 'express';

/**
 * The most a request body may hold. A bank statement passed to parse_ofx can
 * run to several megabytes, well past the usual 100 kB body limit.
 */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export type HttpAppOptions = {
  /** Makes the server for one request; the Actual session behind it is shared. */
  createMcpServer: () => McpServer;
  /** When set, /mcp requires `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Host names the Host header may carry; other requests get a 403. */
  allowedHosts?: string[];
  /** The address the server listens on, which decides the default Host check. */
  host: string;
  log?: (message: string) => void;
};

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

// Compared as digests so the comparison takes the same time whatever the
// length of what was sent, and cannot reveal how much of the token matched.
function digest(text: string) {
  return createHash('sha256').update(text).digest();
}

function bearerAuth(
  token: string,
  log: (message: string) => void,
): RequestHandler {
  const expected = digest(token);
  return (req, res, next) => {
    const [scheme, ...rest] = (req.headers.authorization ?? '').split(' ');
    const supplied = scheme?.toLowerCase() === 'bearer' ? rest.join(' ') : '';
    if (supplied && timingSafeEqual(digest(supplied), expected)) {
      next();
      return;
    }
    log(`refused a ${req.method} /mcp request without a valid bearer token`);
    res.set('WWW-Authenticate', 'Bearer');
    jsonRpcError(
      res,
      401,
      'Unauthorized: send the MCP_AUTH_TOKEN as a bearer token.',
    );
  };
}

/**
 * The HTTP side of the server: POST /mcp for MCP, and GET /healthz for
 * whoever watches the container.
 *
 * It is stateless. Each request gets a server and a transport of its own, which
 * is cheap because the tools are stateless: everything slow and shared lives in
 * the Actual session, whose mutex already serializes the tool calls.
 */
export function createHttpApp({
  createMcpServer,
  authToken,
  allowedHosts,
  host,
  log = () => undefined,
}: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  // Before the Host check, so a health check addressed to anything still works.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // A page in a browser can be made to send requests to a server on the
  // loopback address under another site's name (DNS rebinding), so there the
  // Host must be a loopback name. Elsewhere the check is opt-in.
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (LOOPBACK_HOSTS.includes(host)) {
    app.use(localhostHostValidation());
  }

  if (authToken) app.use('/mcp', bearerAuth(authToken, log));

  app.post('/mcp', async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Answer with plain JSON: a tool call is one request and one answer.
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log(
        `POST /mcp failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  });

  // A stateless server has no session to stream to or to end.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.set('Allow', 'POST');
    jsonRpcError(res, 405, 'Method not allowed: use POST.');
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

export type HttpServer = {
  /** The port actually listening, which differs from the one asked for when that was 0. */
  port: number;
  close: () => Promise<void>;
};

/** Listens on the address. Resolves once it is accepting connections. */
export async function serveHttp({
  port,
  ...options
}: HttpAppOptions & { port: number }): Promise<HttpServer> {
  const app = createHttpApp(options);
  const listener = await new Promise<Server>((resolve, reject) => {
    const started = app.listen(port, options.host, () => resolve(started));
    started.once('error', reject);
  });
  const address = listener.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    close: () =>
      new Promise<void>(resolve => {
        listener.close(() => resolve());
        // Stop waiting for clients that keep their connection open.
        listener.closeAllConnections();
      }),
  };
}
