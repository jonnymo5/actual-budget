import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ActualContext, Session } from '#actual/session';
import { isToolError, toolError } from '#errors';

/**
 * - `read`: never changes anything.
 * - `write`: changes data, so it gets a `dry_run` input that defaults to true.
 * - `delete`: like `write`, and applying it also needs `confirm: true`.
 */
export type ToolKind = 'read' | 'write' | 'delete';

export type ToolRunContext = ActualContext & {
  /** Always false for `read` tools. A true value means: preview, change nothing. */
  dryRun: boolean;
};

type ToolSpec<Input extends z.ZodRawShape, Output extends z.ZodRawShape> = {
  name: string;
  title: string;
  /** State units (major currency units) and date formats; the model reads this. */
  description: string;
  kind: ToolKind;
  input: Input;
  output: Output;
  handler: (
    input: z.output<z.ZodObject<Input>>,
    ctx: ToolRunContext,
  ) => Promise<{
    /** Returned as `structuredContent`; validated against `output`. */
    data: z.output<z.ZodObject<Output>>;
    /** Compact text for clients that only show the model `content`. */
    text: string;
  }>;
};

/** A tool with its schemas erased, so tools of any shape can share a list. */
export type ToolDefinition = {
  name: string;
  kind: ToolKind;
  register: (server: McpServer, deps: RegistryDeps) => void;
};

type RegistryDeps = {
  session: Session;
  log?: (message: string) => void;
};

const gateSchema = z.object({
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      'Defaults to true: preview the change and apply nothing. Pass false to apply it.',
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      'Must be true, together with dry_run false, to apply a deletion.',
    ),
});

const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
  read: { readOnlyHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

const GATE_DESCRIPTION: Record<ToolKind, string> = {
  read: '',
  write:
    ' Dry run by default: with dry_run true (the default) nothing is changed and a preview is returned; call again with dry_run false to apply.',
  delete:
    ' Dry run by default: with dry_run true (the default) nothing is changed and a preview is returned. To apply, call again with dry_run false and confirm true.',
};

function errorResult(
  toolName: string,
  error: unknown,
  log?: (message: string) => void,
): CallToolResult {
  const message =
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : error instanceof Error
        ? error.message
        : String(error);
  if (!isToolError(error)) log?.(`${toolName} failed: ${message}`);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function defineTool<
  Input extends z.ZodRawShape,
  Output extends z.ZodRawShape,
>(spec: ToolSpec<Input, Output>): ToolDefinition {
  const { kind } = spec;
  const { dry_run, confirm } = gateSchema.shape;
  const gateShape = {
    read: {},
    write: { dry_run },
    delete: { dry_run, confirm },
  }[kind];
  const outputShape =
    kind === 'read'
      ? spec.output
      : {
          ...spec.output,
          dry_run: z
            .boolean()
            .describe('True when this was only a preview and nothing changed.'),
        };
  const inputSchema = z.object(spec.input);
  // Spelled out as a concrete type: the SDK derives the callback's argument
  // type from it, and a generic shape would leave that undecided.
  const registeredInput: z.ZodRawShape = { ...spec.input, ...gateShape };

  return {
    name: spec.name,
    kind,
    register(server, { session, log }) {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description + GATE_DESCRIPTION[kind],
          inputSchema: registeredInput,
          outputSchema: outputShape,
          annotations: ANNOTATIONS[kind],
        },
        async (args): Promise<CallToolResult> => {
          try {
            const gate = gateSchema.parse(args);
            const dryRun = kind !== 'read' && gate.dry_run;
            if (kind === 'delete' && !dryRun && !gate.confirm) {
              throw toolError(
                `${spec.name} deletes data, so applying it requires confirm: true. Call it with dry_run: true first to preview, then with dry_run: false and confirm: true.`,
              );
            }

            const input = inputSchema.parse(args);
            const access = kind === 'read' || dryRun ? 'read' : 'write';
            const { data, text } = await session.run(access, ctx =>
              spec.handler(input, { ...ctx, dryRun }),
            );

            if (kind === 'read') {
              return {
                content: [{ type: 'text', text }],
                structuredContent: data,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: dryRun
                    ? `DRY RUN - nothing was changed.\n${text}\nCall again with dry_run false${kind === 'delete' ? ' and confirm true' : ''} to apply.`
                    : text,
                },
              ],
              structuredContent: { ...data, dry_run: dryRun },
            };
          } catch (error) {
            return errorResult(spec.name, error, log);
          }
        },
      );
    },
  };
}

/**
 * Registers the tools on the server. With `readOnly`, every tool that could
 * change data is skipped entirely, so it is not even visible to the model.
 * Returns the names that were registered.
 */
export function registerTools(
  server: McpServer,
  tools: ToolDefinition[],
  { readOnly, ...deps }: RegistryDeps & { readOnly: boolean },
): string[] {
  const registered: string[] = [];
  for (const tool of tools) {
    if (readOnly && tool.kind !== 'read') continue;
    tool.register(server, deps);
    registered.push(tool.name);
  }
  return registered;
}
