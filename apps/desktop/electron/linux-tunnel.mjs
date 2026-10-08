import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLinuxSsh } from './linux-ssh.mjs';
import { httpProxy } from './system-proxy.mjs';

export async function startLinuxTunnel(configuration, binaries, signal, onFailure) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-tunnel-'));
  let ssh, child, closing;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('close', resolve));
        child.kill();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        await exited;
        clearTimeout(timer);
      }
      await ssh?.close();
      await rm(directory, { recursive: true, force: true });
    })());
  const abort = () => {
    void close();
  };
  try {
    signal.throwIfAborted();
    ssh = await startLinuxSsh();
    const proxy = httpProxy(
      await binaries.resolveProxy?.(
        `https://${configuration.serverAddr}:${configuration.serverPort}`,
      ),
    );
    const caPath = join(directory, 'server.crt');
    await writeFile(caPath, configuration.certificate, { mode: 0o600 });
    const configPath = join(directory, 'frpc.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverAddr: configuration.serverAddr,
        serverPort: configuration.serverPort,
        loginFailExit: true,
        auth: { method: 'token', token: configuration.token },
        transport: {
          ...(proxy && { proxyURL: `http://${proxy.host}:${proxy.port}` }),
          tls: { enable: true, trustedCaFile: caPath, serverName: configuration.serverName },
        },
        proxies: [
          {
            name: configuration.connectionId,
            type: 'tcp',
            localIP: '127.0.0.1',
            localPort: ssh.port,
            remotePort: configuration.remotePort,
          },
        ],
        log: { to: 'console', level: 'error', disablePrintColor: true },
      }),
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    child = spawn(binaries.frpc, ['-c', configPath], { stdio: 'ignore' });
    child.on('error', () => {
      if (!closing) onFailure('Linux frpc 启动失败，请运行 npm run prepare:linux。');
    });
    child.on('close', () => {
      if (!closing) onFailure('Linux 隧道已退出，请重新连接。');
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    return {
      credentials: {
        type: 'tunnel.credentials',
        connectionId: configuration.connectionId,
        platform: 'linux',
        username: ssh.username,
        privateKey: ssh.privateKey,
        hostPublicKey: ssh.hostPublicKey,
        powershellPath: '/bin/bash',
        schedulesPath: binaries.schedulesPath,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
