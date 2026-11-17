import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { SessionStore } from '../src/store.ts';

const identity = () => ({ id: randomUUID(), key: randomBytes(32).toString('base64url') });
test('device enrollment survives restart, rejects key replacement and isolates create request IDs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'devices-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = identity(),
    b = identity();
  let store = new SessionStore(root);
  store.authenticateDevice(a.id, a.key);
  store.authenticateDevice(b.id, b.key);
  const request = randomUUID();
  const session = store.create(request, 'A', '/same', a.id);
  assert.throws(() => store.create(request, 'A', '/same', b.id), /不属于/);
  assert.throws(() => store.authenticateDevice(a.id, b.key), /设备身份/);
  const fork = store.fork(randomUUID(), session.id, randomUUID(), 'fork', false);
  assert.equal(store.deviceOf(fork.id), a.id);
  store.close();
  store = new SessionStore(root);
  t.after(() => store.close());
  assert.equal(store.verifyDevice(a.id, a.key), true);
  assert.equal(store.verifyDevice(a.id, b.key), false);
  assert.equal(store.listForDevice(a.id).length, 2);
  assert.equal(store.listForDevice(b.id).length, 0);
  store.delete(fork.id);
  assert.equal(store.deviceOf(fork.id), undefined);
});

test('protocol-12 database migration quarantines history in legacy until explicit offline assignment', async (t) => {
  const { assignLegacySessions } = await import(
    new URL('../../../scripts/assign-device-sessions.mjs', import.meta.url).href
  );
  const root = mkdtempSync(join(tmpdir(), 'devices-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new SessionStore(root);
  const old = store.create(randomUUID(), 'old', '/same');
  store.database.exec('DROP TABLE session_devices; DROP TABLE devices');
  store.close();
  store = new SessionStore(root);
  const a = identity();
  store.authenticateDevice(a.id, a.key);
  assert.equal(store.deviceOf(old.id), 'legacy');
  assert.equal(store.listForDevice(a.id).length, 0);
  store.close();
  assert.throws(() => assignLegacySessions(root, randomUUID()), /尚未注册/);
  assert.equal(assignLegacySessions(root, a.id), 1);
  assert.equal(assignLegacySessions(root, a.id), 0);
  store = new SessionStore(root);
  t.after(() => store.close());
  assert.equal(store.listForDevice(a.id)[0].id, old.id);
});
