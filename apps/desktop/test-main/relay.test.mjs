import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';
import { startLinuxTunnel } from '../electron/linux-tunnel.mjs';

const execute = promisify(execFile);
const linux = { skip: process.platform !== 'linux', timeout: 60000 };

async function certificate(directory) {
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'cert.pem');
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ]);
  return { cert: await readFile(certificatePath), key: await readFile(keyPath) };
}
// A native-mode service whose CLI is never started: sign-in, tunnel and relay are real.
async function service(t) {
  const { createProxyServer } = await import('../../server/src/server.ts');
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const tls = await certificate(directory);
  const token = `relay-test-${randomUUID()}`;
  const dataDir = join(directory, 'data');
  const server = createProxyServer({
    token,
    dataDir,
    tls,
    claude: { executable: '/bin/false' },
    tunnel: {
      executable: '/nonexistent/frps',
      publicHost: '127.0.0.1',
      port: 1,
      certificatePath: '',
      keyPath: '',
      serverName: 'localhost',
    },
  });
  const url = (await server.listen(0)).replace('https:', 'wss:') + '/ws';
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { url, token, dataDir, fingerprint: new X509Certificate(tls.cert).fingerprint256 };
}
function messages(socket) {
  const received = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return async (type) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const index = received.findIndex((message) => message.type === type);
      if (index >= 0) return received.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(received)}`);
  };
}
async function signIn(bridge, token) {
  const local = new WebSocket(bridge.url);
  const next = messages(local);
  await new Promise((resolve, reject) => local.once('open', resolve).once('error', reject));
  local.send(
    JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: 'test' }),
  );
  return { local, next };
}
const ssh = (dataDir, connectionId, command) =>
  execute(
    'ssh',
    ['-F', join(dataDir, 'connections', connectionId, 'ssh_config'), 'windows', command],
    {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    },
  );

test(
  'the Linux desktop is reached through the WSS relay, with no frp and no extra port',
  linux,
  async (t) => {
    const { url, token, dataDir, fingerprint } = await service(t);
    const bridge = await openProxyBridge({ url, fingerprint }, { schedulesPath: '/tmp/计划.json' });
    t.after(() => bridge.close());
    const { next } = await signIn(bridge, token);
    // The bridge passes `ready` on only after the service probed SSH through the relay.
    const ready = await next('ready');
    assert.equal(ready.adapter, 'claude-code');
    const connectionId = ready.connectionId;

    const text = await ssh(dataDir, connectionId, "printf '中继 成功'; printf err >&2");
    assert.equal(text.stdout.toString(), '中继 成功');
    assert.equal(text.stderr.toString(), 'err');
    await assert.rejects(ssh(dataDir, connectionId, 'exit 7'), (error) => error.code === 7);

    // More concurrent commands than spare relay connections, and output well beyond the flow-control window.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => ssh(dataDir, connectionId, `printf ${index}`)),
    );
    assert.deepEqual(
      results.map((result) => result.stdout.toString()),
      ['0', '1', '2', '3', '4', '5'],
    );
    const large = await ssh(dataDir, connectionId, 'head -c 8388608 /dev/zero | tr "\\0" a');
    assert.equal(large.stdout.length, 8 * 1024 * 1024);
    assert.equal(
      large.stdout.every((byte) => byte === 0x61),
      true,
    );
    const echoed = await new Promise((resolve, reject) => {
      const child = execFile(
        'ssh',
        ['-F', join(dataDir, 'connections', connectionId, 'ssh_config'), 'windows', 'wc -c'],
        { timeout: 20000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      child.stdin.end(Buffer.alloc(3 * 1024 * 1024, 1));
    });
    assert.equal(echoed, String(3 * 1024 * 1024));

    await bridge.close();
    const deadline = Date.now() + 5000;
    while (existsSync(join(dataDir, 'connections', connectionId)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(join(dataDir, 'connections', connectionId)), false);

    // The device slot is free again for the next connection.
    const again = await openProxyBridge({ url, fingerprint }, {});
    t.after(() => again.close());
    assert.equal((await (await signIn(again, token)).next('ready')).adapter, 'claude-code');
  },
);

test('relay connections without the right secret are refused and counted', linux, async (t) => {
  const { url, token, fingerprint } = await service(t);
  const bridge = await openProxyBridge({ url, fingerprint }, {});
  t.after(() => bridge.close());
  const { connectionId } = await (await signIn(bridge, token)).next('ready');
  for (const attach of [
    { type: 'tunnel.attach', connectionId, secret: 'A'.repeat(43) },
    { type: 'tunnel.attach', connectionId: randomUUID(), secret: 'A'.repeat(43) },
  ]) {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    socket.send(JSON.stringify(attach));
    assert.equal(await new Promise((resolve) => socket.once('close', resolve)), 4001);
  }
});

test('a cancelled Linux tunnel start leaves nothing running', linux, async () => {
  await assert.rejects(
    startLinuxTunnel({ connectionId: 'x', secret: 'x' }, {}, AbortSignal.abort(), () => {}),
    /abort/i,
  );
});
