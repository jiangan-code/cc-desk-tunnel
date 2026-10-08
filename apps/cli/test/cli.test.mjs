import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearConfig, desktopLogin, loadConfig, saveConfig } from '../src/config.mjs';
import { environmentProxy } from '../src/environment.mjs';
import { chooseSession } from '../src/main.mjs';
import { attachTerminal, inputFrames } from '../src/terminal.mjs';
import { Deck, cellWidth, deckRows, fit } from '../src/deck.mjs';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TERMINAL = '22222222-2222-4222-8222-222222222222';

test('service proxy follows https_proxy and no_proxy, never for loopback', () => {
  const env = {
    https_proxy: 'http://proxy.lan:3128',
    no_proxy: 'localhost,.corp.example,10.0.0.5',
  };
  assert.equal(environmentProxy('https://cc.example.com/ws', env), 'PROXY proxy.lan:3128');
  assert.equal(environmentProxy('https://a.corp.example/ws', env), 'DIRECT');
  assert.equal(environmentProxy('https://corp.example/ws', env), 'DIRECT');
  assert.equal(environmentProxy('https://10.0.0.5:8443/ws', env), 'DIRECT');
  assert.equal(environmentProxy('https://127.0.0.1:18787/ws', env), 'DIRECT');
  assert.equal(
    environmentProxy('https://cc.example.com/ws', { ALL_PROXY: 'proxy:8080' }),
    'PROXY proxy:8080',
  );
  assert.equal(
    environmentProxy('https://cc.example.com/ws', { https_proxy: 'socks5://p:1080' }),
    'DIRECT',
  );
  assert.equal(
    environmentProxy('https://cc.example.com/ws', { no_proxy: '*', https_proxy: 'http://p:1' }),
    'DIRECT',
  );
  assert.equal(environmentProxy('https://cc.example.com/ws', {}), 'DIRECT');
});

test('input frames keep surrogate pairs whole', () => {
  const text = 'a'.repeat(4095) + '😀' + 'b';
  const frames = [...inputFrames(text)];
  assert.equal(frames.join(''), text);
  assert.equal(frames[0].length, 4095);
  assert.ok(frames.every((frame) => frame.length <= 4096));
});

test('token goes to the keyring when it answers, otherwise to a private file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccdt-config-'));
  const env = { XDG_CONFIG_HOME: home };
  const keyring = new Map();
  const secrets = async ([action, ...args], input) => {
    const key = args.slice(-1)[0];
    if (action === 'store') return (keyring.set(key, input), '');
    if (action === 'lookup') return keyring.get(key) ?? null;
    if (action === 'clear') return (keyring.delete(key), '');
  };
  const login = { url: 'wss://cc.example.com/ws', fingerprint: '', token: 'x'.repeat(32) };
  try {
    assert.equal(await loadConfig(env, secrets), null);
    assert.equal(await saveConfig(login, env, secrets), 'keyring');
    const file = join(home, 'cc-desk-tunnel/cli.json');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, undefined);
    assert.deepEqual(await loadConfig(env, secrets), login);
    assert.equal(
      (await loadConfig({ ...env, CCDT_TOKEN: 'y'.repeat(30) }, secrets)).token,
      'y'.repeat(30),
    );
    assert.equal(await clearConfig(env, secrets), true);
    assert.equal(keyring.size, 0);

    assert.equal(await saveConfig(login, env, async () => null), 'file');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'cc-desk-tunnel'))).mode & 0o777, 0o700);
    assert.deepEqual(await loadConfig(env, async () => null), login);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('desktop sign-in offers its address and pin, never its token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccdt-desktop-'));
  try {
    await mkdir(join(home, 'CC Desk Tunnel'));
    await writeFile(
      join(home, 'CC Desk Tunnel/settings.json'),
      JSON.stringify({ login: { url: 'wss://h/ws', fingerprint: 'ab', token: 'enc' } }),
    );
    assert.deepEqual(await desktopLogin({ XDG_CONFIG_HOME: home }), {
      url: 'wss://h/ws',
      fingerprint: 'ab',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function fakeConnection(sessions = []) {
  const sent = [];
  const requests = [];
  const listeners = new Set();
  let closeConnection;
  return {
    sent,
    requests,
    ready: { sessions },
    closed: new Promise((resolve) => (closeConnection = resolve)),
    drop: (reason) => closeConnection(reason),
    emit: (message) => listeners.forEach((listener) => listener(message)),
    request: async (command) => (requests.push(command), { ok: true, sessionId: SESSION }),
    control: (message) => sent.push(message),
    onTerminal: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  };
}
function fakeTty() {
  const input = new EventEmitter();
  input.raw = [];
  input.setRawMode = (on) => input.raw.push(on);
  input.resume = () => {};
  input.pause = () => {};
  const output = new EventEmitter();
  output.columns = 500;
  output.rows = 40;
  output.written = '';
  output.write = (text, done) => ((output.written += text), done && queueMicrotask(done));
  return { input, output };
}

test('terminal joins the local tty to the remote CLI and restores it on exit', async () => {
  const connection = fakeConnection();
  const tty = fakeTty();
  const terminal = attachTerminal(connection, SESSION, tty);
  assert.deepEqual(connection.requests[0], {
    type: 'terminal.open',
    sessionId: SESSION,
    cols: 400,
    rows: 40,
  });
  connection.emit({ type: 'terminal.opened', sessionId: SESSION, terminalId: TERMINAL });
  assert.deepEqual(tty.input.raw, [true]);

  tty.input.emit('data', Buffer.from('你好', 'utf8').subarray(0, 4));
  tty.input.emit('data', Buffer.from('你好', 'utf8').subarray(4));
  assert.deepEqual(
    connection.sent.map((message) => message.data),
    ['你', '好'],
  );

  connection.emit({
    type: 'terminal.data',
    sessionId: SESSION,
    terminalId: TERMINAL,
    data: 'x'.repeat(20000),
    bytes: 20000,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(connection.sent.at(-1), {
    type: 'terminal.ack',
    sessionId: SESSION,
    terminalId: TERMINAL,
    bytes: 20000,
  });

  tty.output.columns = 100;
  tty.output.emit('resize');
  tty.output.emit('resize');
  assert.deepEqual(
    connection.sent.filter((message) => message.type === 'terminal.resize'),
    [{ type: 'terminal.resize', sessionId: SESSION, terminalId: TERMINAL, cols: 100, rows: 40 }],
  );

  terminal.close();
  assert.deepEqual(connection.requests.at(-1), {
    type: 'terminal.close',
    sessionId: SESSION,
    terminalId: TERMINAL,
  });
  connection.emit({
    type: 'terminal.closed',
    sessionId: SESSION,
    terminalId: TERMINAL,
    exitCode: 3,
  });
  assert.deepEqual(await terminal.exited, { code: 3 });
  assert.deepEqual(tty.input.raw, [true, false]);
  assert.equal(tty.input.listenerCount('data'), 0);
});

test('a dropped connection ends the terminal with its reason', async () => {
  const connection = fakeConnection();
  const terminal = attachTerminal(connection, SESSION, { ...fakeTty(), continued: true });
  assert.equal(connection.requests[0].continue, true);
  connection.drop('本机 SSH 连接准备超时。');
  await assert.rejects(terminal.exited, /SSH/);
});

test('the directory resumes its latest session unless a new one is asked for', async () => {
  const at = (minute) => `2026-10-08T00:0${minute}:00.000Z`;
  const sessions = [
    { id: 'a', projectPath: '/p', updatedAt: at(1), title: 'old', permissionMode: 'auto' },
    { id: 'b', projectPath: '/p', updatedAt: at(3), title: 'new', permissionMode: 'plan' },
    { id: 'c', projectPath: '/q', updatedAt: at(5), title: 'other', permissionMode: 'auto' },
  ];
  let connection = fakeConnection(sessions);
  assert.equal((await chooseSession(connection, '/p', {})).id, 'b');
  assert.equal(connection.requests.length, 0);

  await chooseSession(connection, '/p', { effort: 'high' });
  assert.deepEqual(connection.requests[0], {
    type: 'session.configure',
    sessionId: 'b',
    permissionMode: 'plan',
    effort: 'high',
  });

  connection = fakeConnection(sessions);
  assert.equal((await chooseSession(connection, '/p', { new: true })).id, SESSION);
  assert.deepEqual(connection.requests[0], {
    type: 'session.create',
    title: 'p',
    projectPath: '/p',
  });
});

test('Ctrl+Q leaves the agent running: input before it is sent, the terminal is detached', async () => {
  const connection = fakeConnection();
  const tty = fakeTty();
  const terminal = attachTerminal(connection, SESSION, tty);
  connection.emit({ type: 'terminal.opened', sessionId: SESSION, terminalId: TERMINAL });
  tty.input.emit('data', Buffer.from('ls\x11rest'));
  assert.deepEqual(await terminal.exited, { detached: true });
  assert.deepEqual(
    connection.sent.map((message) => message.data),
    ['ls'],
  );
  assert.deepEqual(connection.requests.at(-1), {
    type: 'terminal.detach',
    sessionId: SESSION,
    terminalId: TERMINAL,
  });
  // The kitty keyboard protocol's encoding of the same key, when the CLI switched it on.
  const kitty = fakeTty();
  const again = attachTerminal(connection, SESSION, kitty);
  connection.emit({ type: 'terminal.opened', sessionId: SESSION, terminalId: TERMINAL });
  kitty.input.emit('data', Buffer.from('\x1b[113;5u'));
  assert.deepEqual(await again.exited, { detached: true });
});

test('the agent list fits wide text, groups by directory and puts running agents first', () => {
  assert.equal(cellWidth('ab中文'), 6);
  assert.equal(fit('中文标题很长', 7), '中文.. ');
  assert.equal(cellWidth(fit('中文标题很长', 7)), 7);
  assert.equal(fit('ab', 4), 'ab  ');
  const at = (minutes) => new Date(Date.UTC(2026, 9, 8, 12, minutes)).toISOString();
  const session = (id, projectPath, title, minutes) => ({
    id,
    projectPath,
    title,
    updatedAt: at(minutes),
  });
  const sessions = [
    session('a', '/home/u/old', '旧项目', 1),
    session('b', '/home/u/web', '网站', 5),
    session('c', '/home/u/web', '网站修复', 2),
  ];
  const terminals = new Map([['c', { sessionId: 'c', status: 'busy', since: at(3) }]]);
  const rows = deckRows(sessions, terminals, '', '/home/u');
  assert.deepEqual(
    rows.map((row) => row.header ?? row.session.id),
    ['~/web', 'c', 'b', '~/old', 'a'],
  );
  assert.deepEqual(
    deckRows(sessions, terminals, '修复', '/home/u').map((row) => row.header ?? row.session.id),
    ['~/web', 'c'],
  );
});

test('the agent list opens, ends and leaves agents with confirmation', async () => {
  const sessions = [
    { id: SESSION, projectPath: '/p', title: 'one', updatedAt: new Date().toISOString() },
  ];
  const connection = fakeConnection(sessions);
  const tty = fakeTty();
  const deck = new Deck(connection, { ...tty, cwd: '/p', home: '/home/u' });
  connection.emit({
    type: 'terminals.state',
    terminals: [
      {
        terminalId: TERMINAL,
        sessionId: SESSION,
        status: 'busy',
        attached: false,
        since: new Date().toISOString(),
      },
    ],
  });
  let chosen = deck.choose();
  assert.match(tty.output.written, /运行中/);
  tty.input.emit('data', Buffer.from('\r'));
  assert.deepEqual(await chosen, { sessionId: SESSION, continued: true });

  // An agent out of sight that starts waiting rings.
  tty.output.written = '';
  connection.emit({
    type: 'terminals.state',
    terminals: [
      {
        terminalId: TERMINAL,
        sessionId: SESSION,
        status: 'waiting',
        attached: false,
        since: new Date().toISOString(),
      },
    ],
  });
  assert.match(tty.output.written, /\x07/);
  assert.match(tty.output.written, /1 个等你/);

  chosen = deck.choose();
  tty.input.emit('data', Buffer.from('dy'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connection.requests.at(-1), {
    type: 'terminal.close',
    sessionId: SESSION,
    terminalId: TERMINAL,
  });
  // Leaving with an agent running asks first; anything but y keeps the list.
  tty.input.emit('data', Buffer.from('qn'));
  assert.equal(deck.shown, true);
  tty.input.emit('data', Buffer.from('qy'));
  assert.deepEqual(await chosen, { quit: true });
});
