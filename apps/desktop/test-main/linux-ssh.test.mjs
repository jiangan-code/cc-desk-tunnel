import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
import { startLinuxSsh } from '../electron/linux-ssh.mjs';
import { startLinuxTunnel } from '../electron/linux-tunnel.mjs';
import { pathKey, withProject, folderName, isInside } from '../src/paths.ts';
const execute = promisify(execFile);

test('Linux paths preserve case and backslashes without breaking Windows paths', () => {
  assert.notEqual(pathKey('/home/A'), pathKey('/home/a'));
  assert.equal(pathKey('D:\\Work\\'), pathKey('d:/work'));
  assert.deepEqual(withProject(['/home/A'], '/home/a'), ['/home/A', '/home/a']);
  assert.equal(folderName('/home/a\\b'), 'a\\b');
  assert.ok(isInside('/home/A/src', '/home/A/'));
  assert.ok(isInside('/home/a\\/src', '/home/a\\'));
  assert.ok(!isInside('/home/a/src', '/home/a\\'));
  assert.ok(!isInside('/home/Ab', '/home/A'));
  assert.ok(!isInside('/home/a/src', '/home/A'));
  assert.ok(isInside('D:/work/a', 'd:\\work\\'));
});

test(
  'Linux SSH authenticates temporary key, executes Bash and refuses passwords/other keys',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const server = await startLinuxSsh();
    const directory = await mkdtemp(join(tmpdir(), 'linux-ssh-test-'));
    t.after(async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, 'key'), server.privateKey, { mode: 0o600 });
    await writeFile(
      join(directory, 'known'),
      `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`,
    );
    const args = [
      '-F',
      '/dev/null',
      '-p',
      String(server.port),
      '-i',
      join(directory, 'key'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${join(directory, 'known')}`,
      `${server.username}@127.0.0.1`,
    ];
    const result = await execute('ssh', [...args, "printf '中文 空格'; printf error >&2"], {
      timeout: 10000,
    });
    assert.equal(result.stdout, '中文 空格');
    assert.ok(result.stderr.endsWith('error'));
    assert.equal(
      (await execute('ssh', [...args, 'sleep 120 & printf done'], { timeout: 5000 })).stdout,
      'done',
    );
    await assert.rejects(execute('ssh', [...args, 'exit 7']), (error) => error.code === 7);
    for (const auth of [
      { password: 'no' },
      { privateKey: ssh2.utils.generateKeyPairSync('ed25519').private },
    ]) {
      await assert.rejects(
        new Promise((resolve, reject) => {
          const client = new ssh2.Client();
          client.on('ready', () => {
            client.end();
            resolve();
          });
          client.on('error', (error) => {
            client.destroy();
            reject(error);
          });
          client.connect({
            host: '127.0.0.1',
            port: server.port,
            username: server.username,
            readyTimeout: 2000,
            ...auth,
          });
        }),
        /authentication/,
      );
    }
  },
);

test(
  'missing frpc and pre-cancelled Linux startup clean up without hanging',
  { skip: process.platform !== 'linux' },
  async () => {
    const configuration = {
      serverAddr: 'localhost',
      serverPort: 7000,
      remotePort: 12345,
      connectionId: 'test',
      certificate: 'test',
      token: 'test',
      serverName: 'test',
    };
    await assert.rejects(
      startLinuxTunnel(
        configuration,
        { frpc: '/missing/frpc' },
        new AbortController().signal,
        () => {},
      ),
      /ENOENT/,
    );
    await assert.rejects(
      startLinuxTunnel(configuration, {}, AbortSignal.abort(), () => {}),
      /abort/i,
    );
  },
);

test(
  'closing Linux SSH kills an active command process group and releases the listener',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const server = await startLinuxSsh();
    const client = new ssh2.Client();
    t.after(() => client.end());
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject);
      client.connect({
        host: '127.0.0.1',
        port: server.port,
        username: server.username,
        privateKey: server.privateKey,
      });
    });
    const pid = await new Promise((resolve, reject) => {
      client.exec('echo $$; exec sleep 120', (error, stream) => {
        if (error) return reject(error);
        stream.once('data', (data) => resolve(Number(data.toString().trim())));
      });
    });
    assert.ok(pid > 0);
    await server.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'real frp TLS tunnel registers Linux credentials and executes desktop Bash',
  {
    skip: process.platform !== 'linux' || !process.env.FRPS_TEST_PATH,
    timeout: 30000,
  },
  async (t) => {
    const { WindowsTunnel, availablePort } = await import('../../server/src/tunnel.ts');
    const { tunnelCredentialsSchema } = await import('@cc-desk-tunnel/protocol');
    const { randomUUID } = await import('node:crypto');
    const directory = await mkdtemp(join(tmpdir(), 'linux-frp-test-'));
    const certificatePath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    let desktop, remote;
    t.after(async () => {
      await desktop?.close();
      await remote?.close();
      await rm(directory, { recursive: true, force: true });
    });
    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ]);
    const failures = [];
    remote = new WindowsTunnel(
      {
        executable: process.env.FRPS_TEST_PATH,
        publicHost: '127.0.0.1',
        bindHost: '127.0.0.1',
        port: await availablePort(),
        certificatePath,
        keyPath,
        serverName: 'localhost',
      },
      directory,
      randomUUID(),
      () => failures.push('frps exited'),
    );
    desktop = await startLinuxTunnel(
      await remote.start(),
      {
        frpc: new URL('../vendor/frpc', import.meta.url).pathname,
        schedulesPath: '/tmp/桌面/schedules.json',
      },
      new AbortController().signal,
      (error) => failures.push(error),
    );
    await remote.accept(tunnelCredentialsSchema.parse(desktop.credentials));
    assert.equal(remote.ssh.platform, 'linux');
    const result = await execute('ssh', [
      '-F',
      remote.ssh.configPath,
      'windows',
      "printf 'Linux 隧道成功'",
    ]);
    assert.equal(result.stdout, 'Linux 隧道成功');
    assert.deepEqual(failures, []);
  },
);
