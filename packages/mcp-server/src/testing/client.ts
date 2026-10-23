import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import type { Session } from '#actual/session';
import { createServer } from '#server';
import type { ToolDefinition } from '#tools/registry';

type TestClientOptions = {
  session: Session;
  readOnly?: boolean;
  tools?: ToolDefinition[];
  log?: (message: string) => void;
};

const contentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

/**
 * Calls a tool and returns its raw result, the text a client would show the
 * model, and the structured content.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = contentSchema
    .parse(result.content)
    .map(block => block.text ?? '')
    .join('\n');
  return { result, text, data: result.structuredContent };
}

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
    call: (name: string, args: Record<string, unknown> = {}) =>
      callTool(client, name, args),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
