import { createActualSession } from '#actual/connection';
import { loadConfig } from '#config';
import { log } from '#log';
import { createServer } from '#server';
import { serveHttp } from '#transports/http';
import { serveStdio } from '#transports/stdio';

// stdout carries the MCP protocol, so nothing else may write to it.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main() {
  const config = loadConfig(process.env, process.argv.slice(2));
  const session = createActualSession(config, log);
  const makeServer = () =>
    createServer({ session, readOnly: config.readOnly, log });
  const { server, toolNames } = makeServer();
  log(
    `Serving ${toolNames.length} tools${config.readOnly ? ' (read-only)' : ''}: ${toolNames.join(', ')}`,
  );

  // Set once the HTTP transport is listening, so a signal can stop it first.
  let closeTransport: () => Promise<void> = () => Promise.resolve();
  const stop = () => {
    void closeTransport()
      .then(() => session.close())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Open the budget in the background so the first tool call is not the one
  // that pays for the download. A failure here is logged and retried by the
  // next call.
  void session
    .run('read', async () => undefined)
    .catch(error => {
      log(`Could not open the budget yet: ${String(error)}`);
    });

  if (config.transport === 'stdio') {
    await serveStdio(server);
    await session.close();
    return;
  }

  const { host, port, authToken, allowedHosts } = config.http;
  const http = await serveHttp({
    // A server is made for every request; the first one only listed the tools.
    createMcpServer: () => makeServer().server,
    host,
    port,
    authToken,
    allowedHosts,
    log,
  });
  closeTransport = http.close;
  log(
    `Listening on http://${host}:${http.port}/mcp ${authToken ? '(bearer token required)' : '(no MCP_AUTH_TOKEN set: anyone who can reach this port can use the server)'}`,
  );
}

main().catch(error => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
