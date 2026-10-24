import * as api from '@actual-app/api';
import { z } from 'zod';

import { createAmountConverter } from '#actual/amounts';
import type { AccessKind, ActualContext, Session } from '#actual/session';
import { toolError } from '#errors';
import { connectTestClient } from '#testing/client';

import { defineTool } from './registry';
import type { ToolRunContext } from './registry';

// The registry never touches Actual itself, so these tests use a session that
// just records how each call asked for access.
const context: ActualContext = {
  api,
  lootCore: {
    send: async () => {
      throw new Error('this test has no budget');
    },
  },
  amounts: createAmountConverter('USD'),
  budget: { id: 'b', name: 'Test' },
  syncStatus: () => ({ lastSyncedAt: null, lastError: null }),
  today: () => '2026-01-15',
};

function createRecordingSession() {
  const accessKinds: AccessKind[] = [];
  const session: Session = {
    async run(kind, fn) {
      accessKinds.push(kind);
      return fn(context);
    },
    close: async () => undefined,
  };
  return { session, accessKinds };
}

const seen: { input: unknown; ctx: ToolRunContext }[] = [];

const readTool = defineTool({
  name: 'sample_read',
  title: 'Sample read',
  description: 'Reads a thing.',
  kind: 'read',
  input: { id: z.string() },
  output: { id: z.string() },
  async handler(input, ctx) {
    seen.push({ input, ctx });
    return { data: { id: input.id }, text: `read ${input.id}` };
  },
});

const writeTool = defineTool({
  name: 'sample_write',
  title: 'Sample write',
  description: 'Changes things.',
  kind: 'write',
  input: { value: z.string() },
  output: { would_change: z.number() },
  async handler(input, ctx) {
    seen.push({ input, ctx });
    return { data: { would_change: 3 }, text: `change to ${input.value}` };
  },
});

const deleteTool = defineTool({
  name: 'sample_delete',
  title: 'Sample delete',
  description: 'Deletes things.',
  kind: 'delete',
  input: { id: z.string() },
  output: { would_delete: z.number() },
  async handler(input, ctx) {
    seen.push({ input, ctx });
    return { data: { would_delete: 1 }, text: `delete ${input.id}` };
  },
});

const failingTool = defineTool({
  name: 'sample_fails',
  title: 'Sample failure',
  description: 'Fails on purpose.',
  kind: 'read',
  input: { expected: z.boolean() },
  output: {},
  async handler(input) {
    if (input.expected) throw toolError('unknown thing - try another id');
    throw new Error('database is on fire');
  },
});

const allSampleTools = [readTool, writeTool, deleteTool, failingTool];

beforeEach(() => {
  seen.length = 0;
});

async function setup(options: { readOnly?: boolean } = {}) {
  const { session, accessKinds } = createRecordingSession();
  const logged: string[] = [];
  const connection = await connectTestClient({
    session,
    tools: allSampleTools,
    readOnly: options.readOnly,
    log: message => logged.push(message),
  });
  return { ...connection, accessKinds, logged };
}

describe('read-only mode', () => {
  it('offers every tool by default', async () => {
    const { client, toolNames, close } = await setup();

    expect(toolNames).toEqual([
      'sample_read',
      'sample_write',
      'sample_delete',
      'sample_fails',
    ]);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
    await close();
  });

  it('hides every tool that could change data', async () => {
    const { client, toolNames, close } = await setup({ readOnly: true });

    expect(toolNames).toEqual(['sample_read', 'sample_fails']);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'sample_fails',
      'sample_read',
    ]);
    await close();
  });

  it('cannot be talked into running a hidden tool', async () => {
    const { client, close } = await setup({ readOnly: true });

    const result = await client.callTool({
      name: 'sample_write',
      arguments: { value: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('not found') },
    ]);
    expect(seen).toHaveLength(0);
    await close();
  });
});

describe('tool schemas', () => {
  it('gives write tools a dry_run input that defaults to true', async () => {
    const { client, close } = await setup();
    const { tools } = await client.listTools();
    const write = tools.find(tool => tool.name === 'sample_write');

    expect(write?.inputSchema.properties?.dry_run).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(write?.inputSchema.properties).not.toHaveProperty('confirm');
    expect(write?.description).toContain('Dry run by default');
    expect(write?.annotations).toMatchObject({ readOnlyHint: false });
    await close();
  });

  it('gives delete tools dry_run and confirm, and marks them destructive', async () => {
    const { client, close } = await setup();
    const { tools } = await client.listTools();
    const remove = tools.find(tool => tool.name === 'sample_delete');

    expect(remove?.inputSchema.properties?.dry_run).toMatchObject({
      default: true,
    });
    expect(remove?.inputSchema.properties?.confirm).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(remove?.annotations).toMatchObject({ destructiveHint: true });
    await close();
  });

  it('adds no gating inputs to read tools and marks them read-only', async () => {
    const { client, close } = await setup();
    const { tools } = await client.listTools();
    const read = tools.find(tool => tool.name === 'sample_read');

    expect(read?.inputSchema.properties).not.toHaveProperty('dry_run');
    expect(read?.inputSchema.properties).not.toHaveProperty('confirm');
    expect(read?.annotations).toMatchObject({ readOnlyHint: true });
    await close();
  });
});

describe('calling a read tool', () => {
  it('returns structured content and a text block', async () => {
    const { client, accessKinds, close } = await setup();

    const result = await client.callTool({
      name: 'sample_read',
      arguments: { id: 'abc' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: 'abc' });
    expect(result.content).toEqual([{ type: 'text', text: 'read abc' }]);
    expect(accessKinds).toEqual(['read']);
    expect(seen[0].ctx.dryRun).toBe(false);
    await close();
  });
});

describe('calling a write tool', () => {
  it('previews by default and takes read access only', async () => {
    const { client, accessKinds, close } = await setup();

    const result = await client.callTool({
      name: 'sample_write',
      arguments: { value: 'new' },
    });

    expect(result.isError).toBeFalsy();
    expect(seen[0].ctx.dryRun).toBe(true);
    expect(accessKinds).toEqual(['read']);
    expect(result.structuredContent).toEqual({
      would_change: 3,
      dry_run: true,
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'DRY RUN - nothing was changed.\nchange to new\nCall again with dry_run false to apply.',
      },
    ]);
    await close();
  });

  it('applies only when dry_run is explicitly false, with write access', async () => {
    const { client, accessKinds, close } = await setup();

    const result = await client.callTool({
      name: 'sample_write',
      arguments: { value: 'new', dry_run: false },
    });

    expect(seen[0].ctx.dryRun).toBe(false);
    expect(accessKinds).toEqual(['write']);
    expect(result.structuredContent).toEqual({
      would_change: 3,
      dry_run: false,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'change to new' }]);
    await close();
  });

  it('keeps the gating fields out of what the handler receives', async () => {
    const { client, close } = await setup();

    await client.callTool({
      name: 'sample_write',
      arguments: { value: 'new', dry_run: false },
    });

    expect(seen[0].input).toEqual({ value: 'new' });
    await close();
  });
});

describe('calling a delete tool', () => {
  it('previews by default without needing confirm', async () => {
    const { client, close } = await setup();

    const result = await client.callTool({
      name: 'sample_delete',
      arguments: { id: 'x' },
    });

    expect(result.isError).toBeFalsy();
    expect(seen[0].ctx.dryRun).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'DRY RUN - nothing was changed.\ndelete x\nCall again with dry_run false and confirm true to apply.',
      },
    ]);
    await close();
  });

  it('refuses to apply without confirm, and never runs the handler', async () => {
    const { client, accessKinds, close } = await setup();

    const result = await client.callTool({
      name: 'sample_delete',
      arguments: { id: 'x', dry_run: false },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('requires confirm: true'),
      },
    ]);
    expect(seen).toHaveLength(0);
    expect(accessKinds).toEqual([]);
    await close();
  });

  it('does not treat confirm alone as permission to apply', async () => {
    const { client, close } = await setup();

    const result = await client.callTool({
      name: 'sample_delete',
      arguments: { id: 'x', confirm: true },
    });

    expect(seen[0].ctx.dryRun).toBe(true);
    expect(result.structuredContent).toMatchObject({ dry_run: true });
    await close();
  });

  it('applies with dry_run false and confirm true', async () => {
    const { client, accessKinds, close } = await setup();

    const result = await client.callTool({
      name: 'sample_delete',
      arguments: { id: 'x', dry_run: false, confirm: true },
    });

    expect(result.isError).toBeFalsy();
    expect(seen[0].ctx.dryRun).toBe(false);
    expect(accessKinds).toEqual(['write']);
    expect(result.structuredContent).toEqual({
      would_delete: 1,
      dry_run: false,
    });
    await close();
  });
});

describe('errors', () => {
  it('passes an actionable error to the caller without logging it as a fault', async () => {
    const { client, logged, close } = await setup();

    const result = await client.callTool({
      name: 'sample_fails',
      arguments: { expected: true },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'unknown thing - try another id' },
    ]);
    expect(logged).toEqual([]);
    await close();
  });

  it('reports an unexpected failure to the caller and logs it', async () => {
    const { client, logged, close } = await setup();

    const result = await client.callTool({
      name: 'sample_fails',
      arguments: { expected: false },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'database is on fire' },
    ]);
    expect(logged).toEqual(['sample_fails failed: database is on fire']);
    await close();
  });

  it('rejects bad arguments before the handler runs', async () => {
    const { client, close } = await setup();

    const result = await client.callTool({
      name: 'sample_read',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Input validation error') },
    ]);
    expect(seen).toHaveLength(0);
    await close();
  });
});
