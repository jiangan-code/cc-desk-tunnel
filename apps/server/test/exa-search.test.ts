import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareNativeDirectory } from '../src/claude.ts';
import { environmentConfig } from '../src/config.ts';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('EXA_API_KEY turns on Exa search for native runs without copying the key', () => {
  const env = {
    PROXY_ADAPTER: 'claude-code',
    PROXY_PUBLIC_HOST: 'proxy.example.com',
    PROXY_TLS_MODE: 'reverse-proxy',
    FRPS_TLS_CERT: '/private/frp.crt',
    FRPS_TLS_KEY: '/private/frp.key',
    FRPS_SERVER_NAME: 'cc-desk-tunnel.frp',
  };
  assert.equal(environmentConfig(env, '/state').options.claude?.exaSearch, false);
  const options = environmentConfig({ ...env, EXA_API_KEY: 'fake-exa-key' }, '/state').options;
  assert.equal(options.claude?.exaSearch, true);
  assert.doesNotMatch(JSON.stringify(options), /fake-exa-key/);
});

test('a session directory gets the Exa MCP server and loses WebSearch, and both go when Exa is off', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'exa-search-'));
  const cwd = join(dataDir, 'native', 'session');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls)'], deny: ['Read(./secret)'] } }),
  );
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));

  for (let i = 0; i < 2; i++)
    prepareNativeDirectory({ executable: 'claude', exaSearch: true }, dataDir, 'session');
  const settings = read(join(cwd, '.claude', 'settings.local.json'));
  assert.deepEqual(settings.enabledMcpjsonServers, ['exa']);
  assert.deepEqual(settings.permissions, {
    allow: ['Bash(ls)'],
    deny: ['Read(./secret)', 'WebSearch'],
  });
  assert.deepEqual(read(join(cwd, '.mcp.json')).mcpServers, {
    mine: { command: 'x' },
    exa: {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { 'x-api-key': '${EXA_API_KEY}' },
    },
  });

  prepareNativeDirectory({ executable: 'claude' }, dataDir, 'session');
  const off = read(join(cwd, '.claude', 'settings.local.json'));
  assert.equal(off.enabledMcpjsonServers, undefined);
  assert.deepEqual(off.permissions, { allow: ['Bash(ls)'], deny: ['Read(./secret)'] });
  assert.deepEqual(read(join(cwd, '.mcp.json')).mcpServers, { mine: { command: 'x' } });
});

test('turning Exa off leaves no trace in a directory that had nothing else', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'exa-search-'));
  prepareNativeDirectory({ executable: 'claude', exaSearch: true }, dataDir, 'session');
  prepareNativeDirectory({ executable: 'claude' }, dataDir, 'session');
  const cwd = join(dataDir, 'native', 'session');
  assert.equal(existsSync(join(cwd, '.mcp.json')), false);
  const settings = read(join(cwd, '.claude', 'settings.local.json'));
  assert.equal(settings.permissions, undefined);
  assert.equal(settings.enabledMcpjsonServers, undefined);
});
