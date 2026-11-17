import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import ssh2 from 'ssh2';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { RelayTunnel } from '../../server/src/relay.ts';
import { createProxyServer } from '../../server/src/server.ts';
import { startRelay } from '../electron/relay.mjs';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';
import { loadDeviceIdentity } from '../electron/device-identity.mjs';

const execute = promisify(execFile);
const posix = { skip: process.platform === 'win32', timeout: 60000 };
const identity = () => ({ id: randomUUID(), key: randomBytes(32).toString('base64url') });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, message = 'condition', timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = condition();
    if (value) return value;
    await pause(10);
  }
  throw new Error(`Timed out: ${message}`);
}

// A deterministic CLI substitute: it uses the actual SSH command the service put in its system prompt.
// It never calls a model. Its project commands and file I/O are real Bash/OpenSSH operations.
const CLI = `#!${process.execPath}
const {execFile}=require('node:child_process');
const readline=require('node:readline');
const prompt=process.argv[process.argv.indexOf('--append-system-prompt')+1]||'';
const config=JSON.parse(prompt.match(/ssh -F ("[^"\\n]+") windows/)[1]);
process.stdout.write('CLI_READY\\n');
const nativeFlag=process.argv.includes('--resume')?'--resume':'--session-id';
process.stdout.write('NATIVE_ID '+process.argv[process.argv.indexOf(nativeFlag)+1]+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
 const match=/^RUN (\\S+) (\\S+)$/.exec(line); if(!match)return;
 execFile('ssh',['-F',config,'windows',Buffer.from(match[2],'base64').toString()],{timeout:20000},(error,stdout,stderr)=>{
  process.stdout.write('RESULT '+match[1]+' '+Buffer.from(JSON.stringify({code:error?.code||0,stdout,stderr})).toString('base64')+'\\n');
 });
});
`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'multi-device-'));
  const keyPath = join(directory, 'key');
  const certPath = join(directory, 'cert');
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
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  const executable = join(directory, 'fake-claude.cjs');
  await writeFile(executable, CLI);
  await chmod(executable, 0o755);
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude-home');
  const token = randomBytes(32).toString('base64url');
  const dataDir = join(directory, 'state');
  const server = createProxyServer({
    token,
    dataDir,
    tls,
    resumeGraceMs: 1500,
    accountsDir: join(directory, 'accounts'),
    claude: { executable },
    tunnel: {
      executable: '/missing/frps',
      publicHost: '127.0.0.1',
      port: 1,
      certificatePath: '',
      keyPath: '',
      serverName: 'localhost',
    },
    ...options,
  });
  const url = (await server.listen(0)).replace('https:', 'wss:') + '/ws';
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, tls, token, server, dataDir, url, cleanups };
}

// Two simulated device filesystems expose the same absolute project path. This substitution is only a test
// namespace; each endpoint runs real Bash, and authenticates its own independent SSH keypair.
async function endpoint(root) {
  await mkdir(root, { recursive: true });
  const host = ssh2.utils.generateKeyPairSync('ed25519');
  const key = ssh2.utils.generateKeyPairSync('ed25519');
  const allowed = ssh2.utils.parseKey(key.public);
  const clients = new Set(),
    children = new Set();
  const stop = (child) => {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  };
  const server = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'publickey' &&
        ctx.key.data.equals(allowed.getPublicSSH()) &&
        (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('env', (accept) => accept?.());
        session.on('exec', (accept, reject, info) => {
          const stream = accept();
          const child = spawn(
            '/bin/bash',
            ['-c', info.command.replaceAll('/shared/project', root)],
            { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
          );
          children.add(child);
          child.stdin.on('error', () => {});
          stream.on('error', () => {});
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          stream.on('close', () => stop(child));
          child.on('close', (code) => {
            children.delete(child);
            if (!stream.destroyed) {
              stream.exit(code ?? 128);
              stream.end();
            }
          });
        });
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    privateKey: key.private,
    hostPublicKey: host.public.split(' ').slice(0, 2).join(' '),
    async close() {
      for (const child of children) stop(child);
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function raw(f, device, extra = {}) {
  const client = {
    device,
    frames: [],
    output: new Map(),
    received: 0,
    ready: null,
    offer: null,
    relay: null,
    socket: null,
  };
  async function connect(resume) {
    const socket = new WebSocket(f.url, { ca: f.tls.cert });
    client.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (!['ready', 'resumed', 'resume.ack', 'connection.error'].includes(message.type))
        client.received++;
      if (message.type === 'ready') client.ready = message;
      if (message.type === 'tunnel.relay') client.offer = message;
      if (message.type === 'terminal.data') {
        client.output.set(
          message.terminalId,
          (client.output.get(message.terminalId) || '') + message.data,
        );
        socket.send(
          JSON.stringify({
            type: 'terminal.ack',
            terminalId: message.terminalId,
            sessionId: message.sessionId,
            bytes: message.bytes,
          }),
        );
      }
      client.frames.push(message);
    });
    socket.on('error', () => {});
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    socket.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: PROTOCOL_VERSION,
        token: f.token,
        deviceName: 'test-device',
        tunnel: true,
        tunnelTransport: 'relay',
        resumable: true,
        ...(device && { device }),
        ...extra,
        ...(resume && { resume }),
      }),
    );
    return socket;
  }
  client.next = async (type, predicate = () => true) =>
    until(() => {
      const index = client.frames.findIndex((m) => m.type === type && predicate(m));
      return index < 0 ? null : client.frames.splice(index, 1)[0];
    }, type);
  client.send = (message) => client.socket.send(JSON.stringify(message));
  client.request = async (message) => {
    const requestId = randomUUID();
    client.send({ ...message, requestId });
    return client.next('response', (m) => m.requestId === requestId);
  };
  client.resume = async (proof = device) => {
    const previous = device;
    device = proof;
    await connect({
      connectionId: client.ready.connectionId,
      key: client.ready.resume.key,
      received: client.received,
    });
    device = previous;
    return client.next('resumed');
  };
  client.setup = async () => {
    const ready = await client.next('ready');
    const offer = await client.next('tunnel.relay');
    const root = join(f.directory, 'devices', device?.id ?? 'legacy');
    const ssh = await endpoint(root);
    f.cleanups.push(() => ssh.close());
    client.root = root;
    client.relay = startRelay(
      { ...offer, ...(device && { device }) },
      ssh.port,
      async () => {
        const socket = new WebSocket(f.url, { ca: f.tls.cert });
        await new Promise((resolve, reject) =>
          socket.once('open', () => resolve(socket)).once('error', reject),
        );
        return socket;
      },
      () => {},
    );
    client.send({
      type: 'tunnel.credentials',
      connectionId: ready.connectionId,
      username: 'device',
      privateKey: ssh.privateKey,
      hostPublicKey: ssh.hostPublicKey,
      powershellPath: '/bin/bash',
      platform: client.platform ?? 'linux',
    });
    await client.next('tunnel.ready');
    return client;
  };
  client.create = async () => {
    const response = await client.request({
      type: 'session.create',
      title: 'same project',
      projectPath: '/shared/project',
    });
    assert.equal(response.ok, true);
    return response.sessionId;
  };
  client.open = async (sessionId, flags = {}) => {
    const response = await client.request({
      type: 'terminal.open',
      ...flags,
      sessionId,
      cols: 120,
      rows: 30,
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    const opened = await client.next('terminal.opened', (m) => m.sessionId === sessionId);
    await until(() => client.output.get(opened.terminalId)?.includes('CLI_READY'), 'CLI_READY');
    return opened.terminalId;
  };
  client.run = async (sessionId, terminalId, command) => {
    const marker = randomUUID();
    client.send({
      type: 'terminal.input',
      sessionId,
      terminalId,
      data: `RUN ${marker} ${Buffer.from(command).toString('base64')}\r`,
    });
    const encoded = await until(
      () =>
        new RegExp(`RESULT ${marker} ([A-Za-z0-9+/=]+)`).exec(
          client.output.get(terminalId) || '',
        )?.[1],
      'command result',
      25000,
    );
    return JSON.parse(Buffer.from(encoded, 'base64').toString());
  };
  f.cleanups.push(async () => {
    client.relay?.close();
    if (client.socket.readyState !== WebSocket.CLOSED) {
      client.socket.close(1000);
      await until(() => client.socket.readyState === WebSocket.CLOSED, 'socket close');
    }
  });
  await connect();
  return client;
}

async function pair(t) {
  const f = await fixture(t);
  const a = await raw(f, identity());
  await a.setup();
  const b = await raw(f, identity());
  b.platform = 'darwin';
  await b.setup();
  return { f, a, b };
}

test(
  'two devices share one WSS/token, isolate identical project paths, commands, files, lists and terminal output',
  posix,
  async (t) => {
    const { f, a, b } = await pair(t);
    const sa = await a.create(),
      sb = await b.create();
    assert.notEqual(sa, sb);
    assert.equal(
      f.server.store.get(sa).session.projectPath,
      f.server.store.get(sb).session.projectPath,
    );
    assert.equal(f.server.store.listForDevice(a.device.id).length, 1);
    assert.equal(f.server.store.listForDevice(b.device.id).length, 1);
    const ta = await a.open(sa),
      tb = await b.open(sb);
    const outputs = await Promise.all([
      a.run(sa, ta, 'cd /shared/project && printf DEVICE_A > marker && cat marker'),
      b.run(sb, tb, 'cd /shared/project && printf DEVICE_B > marker && cat marker'),
    ]);
    assert.deepEqual(
      outputs.map((o) => o.stdout),
      ['DEVICE_A', 'DEVICE_B'],
    );
    assert.equal(await readFile(join(a.root, 'marker'), 'utf8'), 'DEVICE_A');
    assert.equal(await readFile(join(b.root, 'marker'), 'utf8'), 'DEVICE_B');
    assert.equal(
      (await a.run(sa, ta, 'cd /shared/project && rm marker && test ! -e marker')).code,
      0,
    );
    assert.equal(await readFile(join(b.root, 'marker'), 'utf8'), 'DEVICE_B');
    assert.equal(
      (await b.run(sb, tb, 'cd /shared/project && rm marker && test ! -e marker')).code,
      0,
    );
    assert.ok(!a.frames.some((m) => m.type === 'session.updated' && m.session.id === sb));
    assert.ok(!b.frames.some((m) => m.type === 'session.updated' && m.session.id === sa));
    assert.ok(
      !a.output.get(ta).includes(Buffer.from(JSON.stringify(outputs[1])).toString('base64')),
    );
  },
);

test(
  'device A drop/resume and intentional exit leave device B task and SSH channel running',
  posix,
  async (t) => {
    const { f, a, b } = await pair(t);
    const sa = await a.create(),
      sb = await b.create();
    const ta = await a.open(sa),
      tb = await b.open(sb);
    const pendingA = a.run(sa, ta, 'sleep 1; printf A_FINISHED');
    const pendingB = b.run(sb, tb, 'sleep 2; printf B_FINISHED');
    await pause(100);
    a.socket.terminate();
    await pause(100);
    const id = a.ready.connectionId;
    await a.resume();
    a.relay.reset();
    assert.equal(a.ready.connectionId, id);
    assert.equal((await pendingA).stdout, 'A_FINISHED');
    assert.equal((await pendingB).stdout, 'B_FINISHED');
    a.socket.close(1000);
    await until(() => a.socket.readyState === WebSocket.CLOSED, 'A exit');
    assert.equal((await b.run(sb, tb, 'printf B_STILL_RUNNING')).stdout, 'B_STILL_RUNNING');
    assert.ok(f.server.store.get(sb));
  },
);

test(
  'device credentials prevent shared-token session, connection, resume and relay impersonation',
  posix,
  async (t) => {
    const { f, a, b } = await pair(t);
    const sb = await b.create();
    const tb = await b.open(sb);
    for (const command of [
      { type: 'session.subscribe' },
      { type: 'session.history', beforeSequence: 100 },
      { type: 'session.rename', title: 'stolen' },
      { type: 'session.delete' },
      { type: 'terminal.open', cols: 80, rows: 24 },
      { type: 'session.export', offset: 0 },
    ]) {
      const response = await a.request({ ...command, sessionId: sb });
      assert.equal(response.ok, false);
      assert.equal(response.code, 'not_found');
    }
    a.send({ type: 'terminal.input', sessionId: sb, terminalId: tb, data: 'STOLEN\r' });
    assert.equal((await a.next('connection.error')).code, 'terminal_inactive');
    const impostor = await raw(f, { id: b.device.id, key: identity().key });
    assert.equal((await impostor.next('connection.error')).code, 'device_unauthorized');
    const thief = await raw(f, a.device, {
      resume: { connectionId: b.ready.connectionId, key: b.ready.resume.key, received: 0 },
    });
    assert.equal((await thief.next('connection.error')).code, 'resume_failed');
    const socket = new WebSocket(f.url, { ca: f.tls.cert });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'tunnel.attach',
        connectionId: b.offer.connectionId,
        secret: b.offer.secret,
        device: a.device,
      }),
    );
    assert.equal(await new Promise((resolve) => socket.once('close', resolve)), 4001);
    assert.equal((await b.run(sb, tb, 'printf B_SAFE')).stdout, 'B_SAFE');
    assert.equal(f.server.store.get(sb).session.title, 'same project');
    const closed = new Promise((resolve) => a.socket.once('close', resolve));
    a.send({
      type: 'tunnel.credentials',
      connectionId: b.ready.connectionId,
      username: 'device',
      privateKey: 'test',
      hostPublicKey: 'ssh-ed25519 AAAATEST',
      powershellPath: '/bin/bash',
      platform: 'linux',
    });
    assert.equal(await closed, 4002);
    assert.equal(
      (await b.run(sb, tb, 'printf B_AFTER_FORGED_REGISTRATION')).stdout,
      'B_AFTER_FORGED_REGISTRATION',
    );
  },
);

test(
  'stable device reconnect and delayed old cleanup cannot release another device or its replacement',
  posix,
  async (t) => {
    const { f, a, b } = await pair(t);
    const sb = await b.create(),
      tb = await b.open(sb);
    const duplicate = await raw(f, a.device);
    assert.equal((await duplicate.next('connection.error')).code, 'device_busy');
    const originalClose = RelayTunnel.prototype.close;
    let unblock;
    const delayedCleanup = new Promise((resolve) => {
      unblock = resolve;
    });
    RelayTunnel.prototype.close = function () {
      const cleanup = originalClose.call(this);
      return this.id === a.ready.connectionId ? cleanup.then(() => delayedCleanup) : cleanup;
    };
    f.cleanups.push(() => {
      unblock();
      RelayTunnel.prototype.close = originalClose;
    });
    a.socket.terminate();
    await pause(80);
    const replacement = await raw(f, a.device);
    let replacementReady = false;
    const setup = replacement.setup().then(() => {
      replacementReady = true;
    });
    await pause(100);
    assert.equal(replacementReady, false, 'replacement waits for its old cleanup');
    assert.equal(
      (await b.run(sb, tb, 'printf B_DURING_DELAYED_CLEANUP')).stdout,
      'B_DURING_DELAYED_CLEANUP',
    );
    unblock();
    await setup;
    assert.notEqual(replacement.ready.connectionId, a.ready.connectionId);
    await pause(200);
    const blocked = await raw(f, a.device);
    assert.equal((await blocked.next('connection.error')).code, 'device_busy');
    assert.equal((await b.run(sb, tb, 'printf B_AFTER_CLEANUP')).stdout, 'B_AFTER_CLEANUP');
    const created = await replacement.create();
    assert.equal(f.server.store.deviceOf(created), a.device.id);
  },
);

test(
  'legacy protocol 12 is exclusive and keeps old sessions; identified devices cannot claim its history',
  posix,
  async (t) => {
    const f = await fixture(t);
    const old = f.server.store.create(randomUUID(), 'old', '/shared/project');
    const legacy = await raw(f, null, { protocolVersion: 12 });
    await legacy.setup();
    assert.equal(legacy.ready.protocolVersion, 12);
    assert.equal(legacy.ready.sessions[0].id, old.id);
    const blocked = await raw(f, identity());
    assert.equal((await blocked.next('connection.error')).code, 'legacy_device_exclusive');
    legacy.socket.close(1000);
    await until(() => legacy.socket.readyState === WebSocket.CLOSED, 'legacy exit');
    await pause(100);
    const modern = await raw(f, identity());
    await modern.setup();
    assert.equal(modern.ready.sessions.length, 0);
    assert.equal(
      (await modern.request({ type: 'session.subscribe', sessionId: old.id })).code,
      'not_found',
    );
    const oldAgain = await raw(f, null, { protocolVersion: 12 });
    assert.equal((await oldAgain.next('connection.error')).code, 'legacy_device_exclusive');
  },
);

test(
  'production connection bridges persist two installation identities and connect concurrently',
  posix,
  async (t) => {
    const f = await fixture(t);
    const bridges = [];
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.close(1000);
      for (const bridge of bridges) await bridge.close();
    });
    for (const name of ['desktop-profile', 'mac-cli-profile']) {
      const path = join(f.directory, name, 'device.json');
      const bridge = await openProxyBridge(
        { url: f.url, fingerprint: new X509Certificate(f.tls.cert).fingerprint256 },
        { devicePath: path },
      );
      bridges.push(bridge);
      const socket = new WebSocket(bridge.url);
      sockets.push(socket);
      const messages = [];
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
      await new Promise((resolve) => socket.once('open', resolve));
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: PROTOCOL_VERSION,
          token: f.token,
          deviceName: name,
        }),
      );
      const ready = await until(() => messages.find((m) => m.type === 'ready'), 'bridge ready');
      assert.equal(ready.multiDevice, true);
      const first = await loadDeviceIdentity(path);
      assert.deepEqual(await loadDeviceIdentity(path), first);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  },
);

test(
  'after A expires it recovers only its exact native conversation while B keeps running',
  posix,
  async (t) => {
    const { f, a, b } = await pair(t);
    const sa = await a.create(),
      sb = await b.create();
    await a.open(sa);
    const tb = await b.open(sb);
    const cwd = join(f.dataDir, 'native', sa);
    const nativeId = (await readFile(join(cwd, '.ccdt-terminal-session'), 'utf8')).trim();
    const project = join(
      process.env.CLAUDE_CONFIG_DIR,
      'projects',
      cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    );
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, nativeId + '.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        sessionId: nativeId,
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'context-A' },
      }) + '\n',
    );
    const pendingB = b.run(sb, tb, 'sleep 3; printf B_SURVIVED_A_EXPIRY');
    a.socket.terminate();
    await pause(2100);
    const recovered = await raw(f, a.device);
    await recovered.setup();
    assert.deepEqual(
      recovered.ready.sessions.map((s) => s.id),
      [sa],
    );
    const terminal = await recovered.open(sa, { continue: true, recover: true });
    await until(
      () => recovered.output.get(terminal)?.includes('NATIVE_ID ' + nativeId),
      'same native conversation',
    );
    assert.equal((await recovered.run(sa, terminal, 'printf A_RECOVERED')).stdout, 'A_RECOVERED');
    assert.equal((await pendingB).stdout, 'B_SURVIVED_A_EXPIRY');
  },
);
