import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDeviceIdentity } from '../electron/device-identity.mjs';

test('concurrent CLI processes publish one complete, durable private identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'device-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile/device.json');
  const identities = await Promise.all(Array.from({ length: 16 }, () => loadDeviceIdentity(path)));
  assert.ok(
    identities.every(
      (identity) => identity.id === identities[0].id && identity.key === identities[0].key,
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), identities[0]);
  assert.equal(identities[0].key.length, 43);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.notEqual((await loadDeviceIdentity(join(directory, 'other.json'))).id, identities[0].id);
});

test('a corrupt identity is never silently replaced with a new device', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'device-identity-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'device.json');
  await writeFile(path, '{broken');
  await assert.rejects(loadDeviceIdentity(path), /恢复备份/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
