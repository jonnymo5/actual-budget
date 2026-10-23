import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** Serves over stdin/stdout. Resolves once the client disconnects. */
export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  const disconnected = new Promise<void>(resolve => {
    transport.onclose = resolve;
    // The transport only notices a closing client through its own close()
    // call, not when stdin reaches EOF.
    process.stdin.once('end', resolve);
  });
  await server.connect(transport);
  await disconnected;
}
