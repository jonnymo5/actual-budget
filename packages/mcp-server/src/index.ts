import { createActualSession } from '#actual/connection';
import { loadConfig } from '#config';
import { log } from '#log';
import { createServer } from '#server';
import { serveStdio } from '#transports/stdio';

// stdout carries the MCP protocol, so nothing else may write to it.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main() {
  const config = loadConfig();
  const session = createActualSession(config, log);
  const { server, toolNames } = createServer({
    session,
    readOnly: config.readOnly,
    log,
  });
  log(
    `Serving ${toolNames.length} tools${config.readOnly ? ' (read-only)' : ''}: ${toolNames.join(', ')}`,
  );

  const stop = () => {
    void session.close().finally(() => process.exit(0));
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

  await serveStdio(server);
  await session.close();
}

main().catch(error => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
