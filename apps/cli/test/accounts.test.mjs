import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const cli = fileURLToPath(new URL('../bin/ccdt.mjs', import.meta.url));
const sessionId = '11111111-1111-4111-8111-111111111111';
const terminalId = '22222222-2222-4222-8222-222222222222';
const profiles = [
  { profile: 'default', loggedIn: true },
  { profile: 'work', loggedIn: true, email: 'work@example.invalid', subscriptionType: 'max' },
  { profile: 'out', loggedIn: false },
];

// A private stand-in for the daemon; no saved credentials, system service or remote CLI is touched.
async function daemon(t, { legacy = false, rejectProfile = false, others = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ccdt-accounts-'));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests = [];
  let child;
  const session = {
    id: sessionId,
    title: 'test',
    projectPath: directory,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: null,
  };
  wss.on('connection', (socket) => {
    const send = (message) => socket.send(JSON.stringify(message));
    send({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: terminalId,
      adapter: 'claude-code',
      version: '0.2.5',
      sessions: [session, ...others],
    });
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString());
      requests.push(command);
      if (command.type === 'account.status') {
        send({
          type: 'account.state',
          loggedIn: true,
          login: null,
          ...(!legacy && { profile: 'default', profiles }),
        });
        // After the normal mode's agent exits, the list opens. q leaves it.
        if (requests.some((request) => request.type === 'terminal.open'))
          setTimeout(() => child?.write('q'), 50);
      }
      if (command.type === 'terminal.list')
        send({
          type: 'terminals.state',
          terminals: [
            {
              sessionId,
              terminalId,
              status: 'idle',
              attached: false,
              since: new Date().toISOString(),
              profile: 'work',
            },
          ],
        });
      if (command.type === 'terminal.open' && rejectProfile) {
        send({ type: 'connection.error', code: 'invalid_command', message: '请求格式无效。' });
        return;
      }
      send({ type: 'response', requestId: command.requestId, ok: true, sessionId });
      if (command.type === 'terminal.open') {
        send({ type: 'terminal.opened', sessionId, terminalId });
        setTimeout(() => send({ type: 'terminal.closed', sessionId, terminalId, exitCode: 0 }), 20);
      }
    });
  });
  await new Promise((resolve) => server.listen(join(directory, 'ccdt.sock'), resolve));
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    wss.close();
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: directory,
    XDG_CONFIG_HOME: directory,
    CCDT_NOTIFY: '0',
  };
  delete env.HERDR_ENV;
  return {
    directory,
    requests,
    execute: (args) =>
      promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 10000 }),
    // A reader as slow as jq: the pipe is read only once the CLI has closed its connection, i.e. finished printing.
    slowRead: (args) => {
      const printed = join(directory, 'printed');
      wss.once('connection', (socket) => socket.once('close', () => void writeFile(printed, '')));
      return promisify(execFile)(
        'sh',
        ['-c', '"$@" | { until [ -e "$PRINTED" ]; do sleep 0.05; done; cat; }', 'sh'].concat(
          process.execPath,
          cli,
          args,
        ),
        { env: { ...env, PRINTED: printed }, timeout: 10000 },
      );
    },
    terminal: (args) =>
      new Promise((resolve, reject) => {
        child = spawn(process.execPath, [cli, directory, ...args], { env, cols: 120, rows: 40 });
        let output = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI timed out: ${output}`));
        }, 10000);
        child.onData((data) => {
          output += data;
        });
        child.onExit(({ exitCode }) => {
          clearTimeout(timer);
          resolve({ exitCode, output });
        });
      }),
  };
}

test('accounts prints JSON or a Chinese table and ls includes the running account', async (t) => {
  const fake = await daemon(t);
  assert.deepEqual(JSON.parse((await fake.execute(['accounts', '--json'])).stdout), {
    active: 'default',
    accounts: profiles,
  });
  const table = (await fake.execute(['accounts'])).stdout;
  assert.match(table, /当前账号：default/);
  assert.match(table, /work\s+已登录\s+work@example.invalid\s+max/);
  assert.match(table, /out\s+未登录/);
  const agents = JSON.parse((await fake.execute(['ls', '--json'])).stdout);
  assert.equal(agents[0].profile, 'work');
  assert.ok(
    fake.requests.every((request) => ['account.status', 'terminal.list'].includes(request.type)),
  );
});

// Over a pipe, output beyond its 64 KiB buffer is written asynchronously; exiting before it drains cuts it off.
test('ls --json larger than a pipe buffer reaches a pipe whole', async (t) => {
  const now = new Date().toISOString();
  const others = Array.from({ length: 800 }, (_, index) => ({
    id: randomUUID(),
    title: `agent ${index} ${'x'.repeat(80)}`,
    projectPath: `/home/user/projects/agent-${index}`,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  }));
  const fake = await daemon(t, { others });
  const { stdout } = await fake.slowRead(['ls', '--json']);
  assert.ok(stdout.length > 64 * 1024);
  assert.equal(JSON.parse(stdout).length, others.length + 1);
});

test('accounts against a service without multi-account support exits 3 on stderr', async (t) => {
  const fake = await daemon(t, { legacy: true });
  await assert.rejects(
    fake.execute(['accounts', '--json']),
    (error) => error.code === 3 && error.stdout === '' && /服务端不支持多账号/.test(error.stderr),
  );
});

test('launch chooses the account with and without single, for new and resumed sessions', async (t) => {
  for (const single of [false, true])
    for (const fresh of [false, true]) {
      await t.test(`${single ? 'single' : 'deck'} ${fresh ? 'new' : 'resume'}`, async (t) => {
        const fake = await daemon(t);
        const result = await fake.terminal([
          '--account',
          'work',
          ...(single ? ['--single'] : []),
          ...(fresh ? ['--new'] : []),
        ]);
        assert.equal(result.exitCode, 0, result.output);
        const open = fake.requests.find((request) => request.type === 'terminal.open');
        assert.equal(open.profile, 'work');
        assert.equal(!!open.continue, !fresh);
        assert.equal(
          fake.requests.some((request) => request.type === 'session.create'),
          fresh,
        );
        assert.ok(!fake.requests.some((request) => request.type === 'account.use'));
      });
    }
});

test('invalid or signed-out accounts fail before creating or starting an agent', async (t) => {
  const fake = await daemon(t);
  for (const [profile, expected] of [
    ['missing', /没有账号 missing/],
    ['out', /账号 out 尚未登录/],
    ['../bad', /账号名只能/],
  ]) {
    const result = await fake.terminal(['--new', '--account', profile, '--single']);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.output, expected);
  }
  assert.ok(
    !fake.requests.some((request) => ['session.create', 'terminal.open'].includes(request.type)),
  );
});

test('an old terminal.open implementation reports account selection unsupported in both modes', async (t) => {
  const fake = await daemon(t, { rejectProfile: true });
  for (const single of [false, true]) {
    const result = await fake.terminal([
      '--new',
      '--account',
      'work',
      ...(single ? ['--single'] : []),
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /服务端不支持选择账号/);
  }
  assert.equal(fake.requests.filter((request) => request.type === 'terminal.open').length, 2);
  assert.ok(!fake.requests.some((request) => request.type === 'account.use'));
});

test('help explains account selection and resumed terminals', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--help']);
  assert.match(stdout, /--account <账号>/);
  assert.match(stdout, /ccdt accounts/);
  assert.match(stdout, /运行中的终端保留原账号/);
});
