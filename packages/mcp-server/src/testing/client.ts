import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { Session } from '#actual/session';
import { createServer } from '#server';
import type { ToolDefinition } from '#tools/registry';

type TestClientOptions = {
  session: Session;
  readOnly?: boolean;
  tools?: ToolDefinition[];
  log?: (message: string) => void;
};

/** An MCP client wired straight to a real server, with no process or pipe. */
export async function connectTestClient({
  session,
  readOnly = false,
  tools,
  log,
}: TestClientOptions) {
  const { server, toolNames } = createServer({ session, readOnly, tools, log });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    toolNames,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
