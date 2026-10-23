import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './config';

const valid = {
  ACTUAL_SERVER_URL: 'http://actual-server:5006',
  ACTUAL_SERVER_PASSWORD: 'hunter2',
  ACTUAL_SYNC_ID: 'abc-123',
};

describe('loadConfig', () => {
  it('reads the required settings and applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      serverUrl: 'http://actual-server:5006',
      serverPassword: 'hunter2',
      syncId: 'abc-123',
      encryptionPassword: undefined,
      dataDir: path.join(os.tmpdir(), 'actual-mcp'),
      readOnly: false,
    });
  });

  it('reads the optional settings', () => {
    const config = loadConfig({
      ...valid,
      ACTUAL_BUDGET_ENCRYPTION_PASSWORD: 'secret',
      ACTUAL_DATA_DIR: '/data',
      ACTUAL_MCP_READ_ONLY: '1',
    });
    expect(config).toMatchObject({
      encryptionPassword: 'secret',
      dataDir: '/data',
      readOnly: true,
    });
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('parses ACTUAL_MCP_READ_ONLY=%s', (value, expected) => {
    expect(loadConfig({ ...valid, ACTUAL_MCP_READ_ONLY: value }).readOnly).toBe(
      expected,
    );
  });

  it('rejects an unrecognised read-only value instead of guessing', () => {
    expect(() => loadConfig({ ...valid, ACTUAL_MCP_READ_ONLY: 'yes' })).toThrow(
      /ACTUAL_MCP_READ_ONLY must be one of/,
    );
  });

  it('lists every missing required setting at once', () => {
    expect.assertions(4);
    try {
      loadConfig({});
    } catch (error) {
      const message = String(error);
      expect(message).toContain('ACTUAL_SERVER_URL is required');
      expect(message).toContain('ACTUAL_SERVER_PASSWORD is required');
      expect(message).toContain('ACTUAL_SYNC_ID is required');
      expect(message).toContain('Invalid configuration');
    }
  });

  it('treats an empty value like an unset one', () => {
    expect(() => loadConfig({ ...valid, ACTUAL_SYNC_ID: '' })).toThrow(
      'ACTUAL_SYNC_ID is required',
    );
    expect(loadConfig({ ...valid, ACTUAL_DATA_DIR: '' }).dataDir).toBe(
      path.join(os.tmpdir(), 'actual-mcp'),
    );
  });

  it('requires an http(s) server URL', () => {
    expect(() =>
      loadConfig({ ...valid, ACTUAL_SERVER_URL: 'actual-server:5006' }),
    ).toThrow(/ACTUAL_SERVER_URL must start with http/);
  });

  it('never echoes secret values in its error', () => {
    expect.assertions(2);
    try {
      loadConfig({
        ACTUAL_SERVER_URL: 'nope',
        ACTUAL_SERVER_PASSWORD: 'hunter2',
        ACTUAL_SYNC_ID: 'abc-123',
      });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      expect(String(error)).toContain('ACTUAL_SERVER_URL');
    }
  });
});
