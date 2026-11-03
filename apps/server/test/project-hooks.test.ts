import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { terminalHookSettings } from '../src/project-hooks.ts';

const ssh = { platform: 'linux' as const, configPath: '/config', powershellPath: '' };

test('only trusted Linux projects get isolated terminal settings with hook fields retained', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'settings.json');
  let calls = 0;
  const fetch = async () => {
    calls++;
    return JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'exit 2', timeout: 28800, asyncRewake: true }],
          },
        ],
      },
    });
  };
  assert.equal(
    await terminalHookSettings('/project', ssh, [], undefined, output, fetch),
    undefined,
  );
  assert.equal(calls, 0);
  await terminalHookSettings('/project', ssh, ['/project'], undefined, output, fetch);
  const settings = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(settings.hooks.Stop[0].matcher, '*');
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 28800);
  assert.equal(settings.hooks.Stop[0].hooks[0].asyncRewake, true);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /hook-bridge/);
  const provider = join(root, 'provider.json');
  await writeFile(
    provider,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'local' }] }] } }),
  );
  const second = join(root, 'second.json');
  await terminalHookSettings('/project', ssh, ['/project'], provider, second, async () =>
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'changed' }] }] } }),
  );
  const refreshed = JSON.parse(await readFile(second, 'utf8'));
  assert.equal(refreshed.hooks.Stop[0].hooks[0].command, 'local');
  assert.match(refreshed.hooks.Stop[1].hooks[0].command, /changed/);
});

async function run(command: string, path: string, project: string, rewake = false, timeout = 2000) {
  const bridge = new URL('../src/hook-bridge.mjs', import.meta.url).pathname;
  return new Promise<{
    out: string;
    err: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    const child = spawn(process.execPath, [bridge, '/config', project, command, String(rewake)], {
      env: { ...process.env, PATH: path },
    });
    let out = '',
      err = '';
    child.stdout.on('data', (s) => (out += s));
    child.stderr.on('data', (s) => (err += s));
    child.stdin.end('{"hello":"world"}');
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ out, err, code, signal });
    });
  });
}

test('bridge passes input, output and hook exit including rewake; reports disconnect and timeout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const fake = join(bin, 'ssh');
  await writeFile(fake, '#!/bin/bash\nexec /bin/bash -c "$4"\n', { mode: 0o700 });
  const path = `${bin}:${process.env.PATH}`;
  const result = await run('cat; printf error >&2; exit 2', path, root, true);
  assert.deepEqual(result, { out: '{"hello":"world"}', err: 'error', code: 2, signal: null });
  const exit255 = await run('printf hook-error >&2; exit 255', path, root);
  assert.equal(exit255.code, 255);
  assert.equal(exit255.err, 'hook-error');
  const identity = await run(
    'printf "%s|%s" "$CLAUDE_PROJECT_DIR" "$CCDT_REMOTE_SESSION_ID"',
    path,
    root,
  );
  assert.equal(identity.out, `${root}|`);
  const timed = await run('sleep 5', path, root, true, 100);
  assert.equal(timed.signal, 'SIGTERM');
  await writeFile(fake, '#!/bin/bash\nprintf disconnected >&2\nexit 255\n', { mode: 0o700 });
  const disconnected = await run('exit 0', path, root, true);
  assert.equal(disconnected.code, 2);
  assert.match(disconnected.err, /disconnected.*SSH transport failed/s);
});
