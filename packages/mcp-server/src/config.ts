import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export type Config = {
  serverUrl: string;
  serverPassword: string;
  /** The budget's Sync ID (Settings -> Advanced in Actual). */
  syncId: string;
  /** Only needed when the budget uses end-to-end encryption. */
  encryptionPassword: string | undefined;
  dataDir: string;
  /** Registers read tools only. */
  readOnly: boolean;
  /** How clients reach the server: over stdin/stdout, or over HTTP at /mcp. */
  transport: 'stdio' | 'http';
  /** Only used by the http transport. */
  http: {
    host: string;
    port: number;
    /** When set, every /mcp request must carry `Authorization: Bearer <token>`. */
    authToken: string | undefined;
    /** When set, requests whose Host header is not listed are refused. */
    allowedHosts: string[] | undefined;
  };
};

export const DEFAULT_HTTP_PORT = 3600;
export const MIN_AUTH_TOKEN_LENGTH = 16;

function required(name: string) {
  return z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, { error: `${name} is required` });
}

const flag = (name: string) =>
  z
    .enum(['1', 'true', '0', 'false'], {
      error: `${name} must be one of 1, true, 0 or false`,
    })
    .optional()
    .transform(value => value === '1' || value === 'true');

const envSchema = z.object({
  ACTUAL_SERVER_URL: required('ACTUAL_SERVER_URL').refine(
    value => /^https?:\/\/\S+$/.test(value),
    { error: 'ACTUAL_SERVER_URL must start with http:// or https://' },
  ),
  ACTUAL_SERVER_PASSWORD: required('ACTUAL_SERVER_PASSWORD'),
  ACTUAL_SYNC_ID: required('ACTUAL_SYNC_ID'),
  ACTUAL_BUDGET_ENCRYPTION_PASSWORD: z.string().optional(),
  ACTUAL_DATA_DIR: z.string().trim().optional(),
  ACTUAL_MCP_READ_ONLY: flag('ACTUAL_MCP_READ_ONLY'),
  MCP_TRANSPORT: z
    .enum(['stdio', 'http'], {
      error: 'MCP_TRANSPORT must be stdio or http',
    })
    .optional(),
  // Loopback unless told otherwise, so running it by hand never exposes it to
  // the network by accident. The container image sets 0.0.0.0.
  MCP_HTTP_HOST: z.string().trim().optional(),
  MCP_HTTP_PORT: z
    .string()
    .trim()
    .regex(/^\d+$/, { error: 'MCP_HTTP_PORT must be a whole number' })
    .transform(Number)
    .refine(port => port >= 1 && port <= 65535, {
      error: 'MCP_HTTP_PORT must be between 1 and 65535',
    })
    .optional(),
  MCP_AUTH_TOKEN: z
    .string()
    .min(MIN_AUTH_TOKEN_LENGTH, {
      error: `MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`,
    })
    .optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
});

/**
 * `--http` and `--stdio` choose the transport and win over MCP_TRANSPORT, so a
 * client config can say which one it wants without touching the environment.
 */
function transportFromArgs(args: string[]): 'stdio' | 'http' | undefined {
  const unknown = args.filter(arg => arg !== '--http' && arg !== '--stdio');
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument ${unknown[0]}. Use --http or --stdio, or set MCP_TRANSPORT.`,
    );
  }
  const http = args.includes('--http');
  const stdio = args.includes('--stdio');
  if (http && stdio) throw new Error('Use either --http or --stdio, not both.');
  return http ? 'http' : stdio ? 'stdio' : undefined;
}

/**
 * Parses and validates the environment (and the command-line flags, if any).
 * Throws one error listing every problem, so a misconfigured deployment can be
 * fixed in a single pass.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = [],
): Config {
  const transportFlag = transportFromArgs(args);
  // An empty value in a .env file means "unset".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== ''),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map(issue => `  - ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }

  const parsed = result.data;
  return {
    serverUrl: parsed.ACTUAL_SERVER_URL,
    serverPassword: parsed.ACTUAL_SERVER_PASSWORD,
    syncId: parsed.ACTUAL_SYNC_ID,
    encryptionPassword: parsed.ACTUAL_BUDGET_ENCRYPTION_PASSWORD,
    dataDir: parsed.ACTUAL_DATA_DIR || path.join(os.tmpdir(), 'actual-mcp'),
    readOnly: parsed.ACTUAL_MCP_READ_ONLY,
    transport: transportFlag ?? parsed.MCP_TRANSPORT ?? 'stdio',
    http: {
      host: parsed.MCP_HTTP_HOST || '127.0.0.1',
      port: parsed.MCP_HTTP_PORT ?? DEFAULT_HTTP_PORT,
      authToken: parsed.MCP_AUTH_TOKEN,
      allowedHosts: parsed.MCP_ALLOWED_HOSTS
        ? parsed.MCP_ALLOWED_HOSTS.split(',')
            .map(host => host.trim())
            .filter(Boolean)
        : undefined,
    },
  };
}
