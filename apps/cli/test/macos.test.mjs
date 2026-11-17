import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { macSecrets, saveConfig } from '../src/config.mjs';
import { LAUNCH_LABEL, launchAgentFile, manageLaunchAgent } from '../src/launchd.mjs';

const url = 'wss://example.com/ws';
const store = ['store', '--label', 'CC Desk Tunnel', 'service', 'cc-desk-tunnel', 'url', url];

test('Mac Keychain writes use stdin with escaping and verify the full secret', async () => {
  const calls = [];
  const token = 'token "quoted" \\ path; $(literal)';
  const run = async (...args) => {
    calls.push(args);
    return calls.length === 1 ? '' : token + '\n';
  };
  assert.equal(await macSecrets(store, token, {}, run), '');
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/security', ['-i']]);
  assert.ok(!calls[0][1].join(' ').includes(token));
  assert.equal(
    calls[0][2],
    `"add-generic-password" "-U" "-s" "cc-desk-tunnel" "-a" "${url}" "-w" "token \\"quoted\\" \\\\ path; $(literal)"\n`,
  );
  assert.deepEqual(calls[1][1], ['find-generic-password', '-s', 'cc-desk-tunnel', '-a', url, '-w']);
  assert.equal(await macSecrets(store, 'different', {}, async () => ''), null);
  let attempted = false;
  for (const invalid of ['line\nbreak', 'carriage\rreturn', 'null\0byte', 'x'.repeat(4096)]) {
    assert.equal(
      await macSecrets(store, invalid, {}, async () => {
        attempted = true;
        return '';
      }),
      null,
    );
  }
  assert.equal(attempted, false);
});

test('Mac Keychain lookup and deletion address the same service account', async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return 'value';
  };
  for (const action of ['lookup', 'clear']) {
    assert.equal(
      await macSecrets([action, 'service', 'cc-desk-tunnel', 'url', url], '', {}, run),
      'value',
    );
  }
  assert.equal(calls[0][1][0], 'find-generic-password');
  assert.equal(calls[1][1][0], 'delete-generic-password');
  assert.ok(calls.every((call) => call[1].includes(url)));
});

test('Mac refuses a plaintext fallback and keeps the previous config when Keychain fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-mac-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: root };
  const credentials = { url, fingerprint: '', token: 'private-value' };
  await saveConfig(credentials, env, async () => '', 'darwin');
  const path = join(root, 'cc-desk-tunnel/cli.json');
  const original = await readFile(path, 'utf8');
  assert.ok(!original.includes(credentials.token));
  await assert.rejects(
    saveConfig(credentials, env, async () => null, 'darwin'),
    /钥匙串/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
});

test('LaunchAgent escapes argv and stores tool paths without credentials or proxy variables', () => {
  const plist = launchAgentFile({
    execPath: '/test path/node',
    script: '/test & <source>/ccdt.mjs',
    home: '/Users/test',
    env: {
      PATH: '/custom/bin:/usr/bin',
      XDG_CONFIG_HOME: '/config & data',
      CCDT_TOKEN: 'SECRET',
      https_proxy: 'http://user:password@proxy',
      CCDT_NOTIFY: '0',
    },
  });
  assert.ok(plist.includes('<string>/test path/node</string>'));
  assert.ok(plist.includes('/test &amp; &lt;source&gt;/ccdt.mjs'));
  assert.ok(plist.includes('<string>daemon</string><string>run</string>'));
  assert.ok(plist.includes('/config &amp; data'));
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.doesNotMatch(plist, /SECRET|password|https_proxy|CCDT_TOKEN/);
});

test('launchd installs, replaces, stops and uninstalls an unprivileged user agent', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ccdt-launchd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const run = async (exe, args) => {
    assert.equal(exe, '/bin/launchctl');
    calls.push(args);
    if (args[0] === 'bootout' && calls.length === 1)
      throw Object.assign(new Error('not loaded'), { code: 3 });
    return { stdout: '' };
  };
  const options = {
    home,
    uid: 501,
    run,
    env: { PATH: '/test/bin' },
    execPath: '/test/node',
    script: '/test/ccdt.mjs',
  };
  const path = await manageLaunchAgent('install', options);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['bootout', 'enable', 'bootstrap'],
  );
  assert.deepEqual(calls[2], ['bootstrap', 'gui/501', path]);
  assert.ok((await readFile(path, 'utf8')).includes(LAUNCH_LABEL));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(home, 'Library/Logs/cc-desk-tunnel/daemon.log'))).mode & 0o777,
    0o600,
  );
  assert.equal(await manageLaunchAgent('status', options), 'loaded');
  await manageLaunchAgent('stop', options);
  await stat(path);
  await manageLaunchAgent('install', options);
  await manageLaunchAgent('uninstall', options);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('launchd treats missing jobs as inactive and preserves permission errors', async () => {
  const options = { home: homedir(), uid: 501 };
  assert.equal(
    await manageLaunchAgent('status', {
      ...options,
      run: async () => {
        throw Object.assign(new Error('missing'), { code: 113 });
      },
    }),
    'inactive',
  );
  for (const command of ['status', 'stop']) {
    await assert.rejects(
      manageLaunchAgent(command, {
        ...options,
        run: async () => {
          throw Object.assign(new Error('denied'), { code: 1 });
        },
      }),
      /denied/,
    );
  }
});
