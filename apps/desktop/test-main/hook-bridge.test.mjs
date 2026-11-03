import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startLinuxSsh } from '../electron/linux-ssh.mjs';
import { sshConfig } from '../../server/src/tunnel.ts';

const bridge = new URL('../../server/src/hook-bridge.mjs', import.meta.url).pathname;
test(
  'bridge uses the real Linux SSH endpoint and delivers the session identity',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ccdt-real-hook-'));
    const desktop = await startLinuxSsh();
    t.after(async () => {
      await desktop.close();
      await rm(root, { recursive: true, force: true });
    });
    const config = sshConfig(root, desktop.port, desktop.username, desktop.hostPublicKey, 'linux');
    await writeFile(join(root, 'identity'), desktop.privateKey, { mode: 0o600 });
    await writeFile(join(root, 'known_hosts'), config.knownHosts);
    await writeFile(join(root, 'config'), config.config);
    const child = spawn(
      process.execPath,
      [
        bridge,
        join(root, 'config'),
        root,
        'cat; printf "%s" "$CCDT_REMOTE_SESSION_ID" >&2; exit 2',
        'true',
      ],
      { env: { ...process.env, CCDT_SESSION_ID: 'session-123' } },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.stdin.end('{"hook":true}');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 2);
    assert.equal(out, '{"hook":true}');
    assert.equal(err, 'session-123');
  },
);
