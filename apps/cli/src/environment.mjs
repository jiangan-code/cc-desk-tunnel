import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The proxy for a service address in the PAC form the bridge reads ("PROXY host:port" or "DIRECT"), taken from the
// usual https_proxy / all_proxy / no_proxy variables. Only plain HTTP proxies are used, as on the desktop.
export function environmentProxy(target, env = process.env) {
  const { hostname } = new URL(target);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return 'DIRECT';
  for (const entry of (env.no_proxy ?? env.NO_PROXY ?? '').split(',')) {
    const name = entry
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '')
      .replace(/^\*?\./, '');
    if (name === '*' || (name && (host === name || host.endsWith(`.${name}`)))) return 'DIRECT';
  }
  const value = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  if (!value) return 'DIRECT';
  try {
    const proxy = new URL(value.includes('://') ? value : `http://${value}`);
    return proxy.protocol === 'http:' ? `PROXY ${proxy.hostname}:${proxy.port || 80}` : 'DIRECT';
  } catch {
    return 'DIRECT';
  }
}

// frpc from, in order: an explicit path, a copy next to this client, the source tree's prepared vendor directory,
// the installed desktop package, then PATH.
export async function findFrpc(env = process.env) {
  const candidates = [
    env.PROXY_FRPC_PATH,
    fileURLToPath(new URL('../vendor/frpc', import.meta.url)),
    fileURLToPath(new URL('../../desktop/vendor/frpc', import.meta.url)),
    '/opt/CC Desk Tunnel/resources/vendor/frpc',
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'frpc')),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    '找不到 frpc。请在源码目录运行 npm run prepare:linux，或用 PROXY_FRPC_PATH 指定。',
  );
}
