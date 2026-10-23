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
};

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
});

/**
 * Parses and validates the environment. Throws one error listing every
 * problem, so a misconfigured deployment can be fixed in a single pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
  };
}
