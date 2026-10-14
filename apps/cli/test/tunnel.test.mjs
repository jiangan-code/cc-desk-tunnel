import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../bin/ccdt-tunnel', import.meta.url));
const linux = { skip: process.platform !== 'linux' };

// Stand-ins for the commands the script asks about the network and drives: the route to the host goes through
// $ROUTE_DEV (tun0 is a TUN interface), the ports in $LISTEN are listening, a forward through a proxy runs while a
// direct one fails at once, and ssh and systemctl calls are logged.
const FAKES = {
  ssh: `[ "$1" = -G ] && { echo "hostname vps.example"; exit 0; }
echo "$*" >> "$LOG/ssh"
case "$*" in *ProxyCommand*) exec sleep 30 ;; esac
exit 255`,
  getent: 'echo "203.0.113.7 STREAM vps.example"',
  ip: `case "$*" in
  "route get"*) echo "203.0.113.7 dev $ROUTE_DEV src 10.0.0.2 uid 1000" ;;
  *"show dev tun0") echo "5: tun0: <POINTOPOINT,UP> mtu 9000 link/none promiscuity 0 tun type tun pi off" ;;
  *) echo "2: eth0: <UP> mtu 1500 link/ether 00:00:00:00:00:01" ;;
esac`,
  ss: `for port in $LISTEN; do case "$*" in *":$port )"*) echo "LISTEN 0 4096 127.0.0.1:$port 0.0.0.0:*" ;; esac; done`,
  systemctl: 'echo "$*" >> "$LOG/systemctl"',
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-tunnel-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const run = join(root, 'run');
  for (const directory of [bin, run, join(home, '.config/cc-desk-tunnel')])
    await mkdir(directory, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(
    join(home, '.config/cc-desk-tunnel/tunnel.conf'),
    "host='vps'\nports='18787'\nproxies=''\n",
  );
  const v2rayn = join(home, '.local/share/v2rayN/guiConfigs');
  await mkdir(v2rayn, { recursive: true });
  await writeFile(join(v2rayn, 'guiNConfig.json'), '{ "Inbound": [{ "LocalPort": 10808 }] }');
  const env = (network) => ({
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: run,
    LOG: root,
    ...network,
  });
  const state = join(run, 'ccdt-tunnel.state');
  return {
    root,
    env,
    state,
    // The forward as `run` left it: the route it uses, the ones it skipped and the routes it saw.
    held: (route, skipped, seen) =>
      writeFile(state, `route='${route}'\nskipped='${skipped}'\nseen='${seen}'\n`),
    check: (network) => promisify(execFile)('sh', [script, 'check'], { env: env(network) }),
    log: (name) => readFile(join(root, name), 'utf8').catch(() => ''),
  };
}
const TUN = { ROUTE_DEV: 'tun0', LISTEN: '10808' };

test('the forward moves to a TUN that came up after it', linux, async () => {
  const t = await setup();
  try {
    await t.held('socks:10808', '', 'socks:10808 ');
    const { stdout } = await t.check(TUN);
    assert.match(stdout, /从 socks:10808 换到 tun:tun0/);
    assert.match(await t.log('systemctl'), /restart ccdt-tunnel\.service/);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test('a direct forward moves to the proxy once it listens', linux, async () => {
  const t = await setup();
  try {
    await t.held('direct', '', 'direct ');
    await t.check({ ROUTE_DEV: 'eth0', LISTEN: '10808' });
    assert.match(await t.log('systemctl'), /restart ccdt-tunnel\.service/);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test(
  'the forward stays on the best route, and off one that failed while nothing changed',
  linux,
  async () => {
    const t = await setup();
    try {
      await t.held('tun:tun0', '', 'tun:tun0 socks:10808 ');
      await t.check(TUN);
      await t.held('socks:10808', ' tun:tun0', 'tun:tun0 socks:10808 ');
      await t.check(TUN);
      assert.doesNotMatch(await t.log('systemctl'), /restart/);
      // The routes changed since: the one that failed is worth another try.
      await t.held('socks:10808', ' tun:tun0', 'socks:10808 ');
      await t.check(TUN);
      assert.match(await t.log('systemctl'), /restart/);
    } finally {
      await rm(t.root, { recursive: true, force: true });
    }
  },
);

test('run falls back to the proxy port when the TUN route fails', linux, async () => {
  const t = await setup();
  // Its own process group, so the forward it starts ends with it.
  const child = spawn('sh', [script, 'run'], { env: t.env(TUN), stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 100 && !/ProxyCommand/.test(await t.log('ssh')); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const [direct, proxied] = (await t.log('ssh')).trim().split('\n');
    assert.doesNotMatch(direct, /ProxyCommand/);
    assert.match(proxied, /ProxyCommand=nc -X 5 -x 127\.0\.0\.1:10808 %h %p/);
    assert.match(proxied, /-L 127\.0\.0\.1:18787:127\.0\.0\.1:18787 vps$/);
    assert.equal(
      await readFile(t.state, 'utf8'),
      "route='socks:10808'\nskipped=' tun:tun0'\nseen='tun:tun0 socks:10808 '\n",
    );
  } finally {
    process.kill(-child.pid);
    await rm(t.root, { recursive: true, force: true });
  }
});
