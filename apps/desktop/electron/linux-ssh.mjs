import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

// The only variables a command may carry from the service: which CLI session sent it, and what a terminal launch set
// (the protocol's LAUNCH_ENV_NAME). The session id arrives under the CLI's own name and is exported as
// CCDT_REMOTE_SESSION_ID, so a local Claude Code started from that shell never mistakes it for its own.
const LAUNCH_ENV_NAME = /^(FM|CCDT)_[A-Z0-9_]{1,64}$/;
export function acceptedEnvironment(key, value) {
  if (
    typeof key !== 'string' ||
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\0')
  )
    return null;
  if (key === 'CLAUDE_CODE_SESSION_ID') return ['CCDT_REMOTE_SESSION_ID', value];
  if (key === 'CCDT_REMOTE_SESSION_ID') return null;
  return LAUNCH_ENV_NAME.test(key) ? [key, value] : null;
}

// A per-connection SSH exec endpoint, owned by the desktop user. No password,
// forwarding, PTY, SFTP or interactive shell is exposed.
export async function startLinuxSsh() {
  const { default: ssh2 } = await import('ssh2');
  const { Server, utils } = ssh2;
  const keyPair = () => utils.generateKeyPairSync('ed25519');
  const host = keyPair();
  const identity = keyPair();
  const allowed = utils.parseKey(identity.public);
  const username = userInfo().username;
  const clients = new Set();
  const commands = new Set();
  const stopped = new WeakSet();
  const stop = (child) => {
    if (!child.pid || stopped.has(child)) return;
    stopped.add(child);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const server = new Server({ hostKeys: [host.private], readyTimeout: 10000 }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (
        ctx.username !== username ||
        ctx.method !== 'publickey' ||
        ctx.key.algo !== allowed.type ||
        !ctx.key.data.equals(allowed.getPublicSSH()) ||
        (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
      ) {
        ctx.reject(['publickey']);
      } else ctx.accept();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        const env = {};
        session.on('env', (accept, reject, info) => {
          const entry = acceptedEnvironment(info.key, info.val);
          if (entry) env[entry[0]] = entry[1];
          (entry ? accept : reject)?.();
        });
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          const child = spawn('/bin/bash', ['-c', info.command], {
            cwd: homedir(),
            env: { ...process.env, ...env },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          commands.add(child);
          child.stdin.on('error', () => {});
          stream.on('error', () => {});
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          stream.once('close', () => stop(child));
          child.once('exit', () => stop(child));
          child.once('error', () => {
            stream.exit(127);
            stream.end();
          });
          child.once('close', (code) => {
            stop(child);
            commands.delete(child);
            if (!stream.destroyed) {
              stream.exit(code ?? 128);
              stream.end();
            }
          });
        });
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    username,
    privateKey: identity.private,
    hostPublicKey: host.public.split(' ').slice(0, 2).join(' '),
    async close() {
      const exited = [...commands].map(
        (child) => new Promise((resolve) => child.once('close', resolve)),
      );
      for (const child of commands) stop(child);
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all(exited);
    },
  };
}
