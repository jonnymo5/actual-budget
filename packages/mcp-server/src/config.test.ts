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
      transport: 'stdio',
      http: {
        host: '127.0.0.1',
        port: 3600,
        authToken: undefined,
        allowedHosts: undefined,
      },
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
  describe('transport', () => {
    it('serves over stdio unless told otherwise', () => {
      expect(loadConfig(valid).transport).toBe('stdio');
      expect(loadConfig({ ...valid, MCP_TRANSPORT: 'stdio' }).transport).toBe(
        'stdio',
      );
    });

    it('takes http from MCP_TRANSPORT or from --http', () => {
      expect(loadConfig({ ...valid, MCP_TRANSPORT: 'http' }).transport).toBe(
        'http',
      );
      expect(loadConfig(valid, ['--http']).transport).toBe('http');
    });

    it('lets a flag win over the environment', () => {
      expect(
        loadConfig({ ...valid, MCP_TRANSPORT: 'http' }, ['--stdio']).transport,
      ).toBe('stdio');
    });

    it('rejects unknown transports, unknown flags and contradictory flags', () => {
      expect(() => loadConfig({ ...valid, MCP_TRANSPORT: 'sse' })).toThrow(
        /MCP_TRANSPORT must be stdio or http/,
      );
      expect(() => loadConfig(valid, ['--serve'])).toThrow(
        /Unknown argument --serve/,
      );
      expect(() => loadConfig(valid, ['--http', '--stdio'])).toThrow(
        /either --http or --stdio/,
      );
    });
  });

  describe('http settings', () => {
    it('reads the host, port, token and allowed hosts', () => {
      expect(
        loadConfig({
          ...valid,
          MCP_HTTP_HOST: '0.0.0.0',
          MCP_HTTP_PORT: '4000',
          MCP_AUTH_TOKEN: 'a-token-of-16-chars',
          MCP_ALLOWED_HOSTS: 'actual.example.ts.net, localhost,',
        }).http,
      ).toEqual({
        host: '0.0.0.0',
        port: 4000,
        authToken: 'a-token-of-16-chars',
        allowedHosts: ['actual.example.ts.net', 'localhost'],
      });
    });

    it('treats empty values like unset ones', () => {
      expect(
        loadConfig({
          ...valid,
          MCP_HTTP_PORT: '',
          MCP_AUTH_TOKEN: '',
          MCP_ALLOWED_HOSTS: '',
        }).http,
      ).toEqual({
        host: '127.0.0.1',
        port: 3600,
        authToken: undefined,
        allowedHosts: undefined,
      });
    });

    it.each(['abc', '3600.5', '0', '65536', '-1'])(
      'rejects the port %s',
      port => {
        expect(() => loadConfig({ ...valid, MCP_HTTP_PORT: port })).toThrow(
          /MCP_HTTP_PORT must be/,
        );
      },
    );

    it('rejects a token too short to be safe', () => {
      expect(() => loadConfig({ ...valid, MCP_AUTH_TOKEN: 'short' })).toThrow(
        /MCP_AUTH_TOKEN must be at least 16 characters/,
      );
    });
  });
});
