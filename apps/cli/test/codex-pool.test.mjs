import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseQuota, pickAccount } from '../src/codex-pool.mjs';

const now = Date.parse('2026-01-01T00:00:00Z');
const quota = (five, week, time = now) => ({
  fiveHour: { remaining: five },
  weekly: { remaining: week },
  fetchedAt: new Date(time).toISOString(),
});
test('parses usage windows and rejects invalid quota', () => {
  assert.deepEqual(
    parseQuota(
      {
        rate_limit: {
          primary_window: { used_percent: 12.5, reset_at: 1767229200 },
          secondary_window: { used_percent: 40, reset_after_seconds: 60 },
        },
      },
      now,
    ),
    {
      fiveHour: { remaining: 87.5, resetAt: '2026-01-01T01:00:00.000Z' },
      weekly: { remaining: 60, resetAt: '2026-01-01T00:01:00.000Z' },
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  );
  assert.throws(() => parseQuota({ rate_limit: { primary_window: { used_percent: 101 } } }, now));
  assert.throws(() => parseQuota({}, now));
  assert.throws(() => parseQuota({ rate_limit: { allowed: false } }, now), /rate limited/);
});
test('picks by five hour then weekly, excluding exhausted and stale accounts', () => {
  const accounts = [
    { name: 'a', quota: quota(90, 5) },
    { name: 'b', quota: quota(80, 50) },
    { name: 'c', quota: quota(80, 70) },
    { name: 'd', quota: quota(99, 99, now - 900001) },
    { name: 'e', quota: null },
  ];
  assert.equal(pickAccount(accounts, now).name, 'c');
  assert.equal(pickAccount([accounts[0]], now), null);
});
test('imports private auth and selects cached fake quota without exposing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccdt-pool-test-'));
  try {
    const source = join(dir, 'source.json');
    await writeFile(
      source,
      JSON.stringify({ tokens: { access_token: 'secret-test-token', id_token: 'fake' } }),
    );
    const env = { ...process.env, CCDT_CODEX_POOL: join(dir, 'pool') };
    const cli = new URL('../bin/ccdt.mjs', import.meta.url).pathname;
    const run = (...args) =>
      spawnSync(process.execPath, [cli, 'codex-pool', ...args], { env, encoding: 'utf8' });
    const imported = run('import', 'test', source);
    assert.equal(imported.status, 0);
    assert.ok(!imported.stdout.includes('secret-test-token'));
    assert.equal((await stat(join(dir, 'pool/test/auth.json'))).mode & 0o777, 0o600);
    await writeFile(join(dir, 'pool/test/quota.json'), JSON.stringify(quota(75, 80, Date.now())));
    assert.equal(JSON.parse(run('pick').stdout).name, 'test');
    assert.equal(run('pick', '--env').stdout.trim(), `CODEX_HOME=${dir}/pool/test`);
    assert.ok(!run('list').stdout.includes('secret-test-token'));
    assert.equal(run('remove', 'test').status, 0);
    await assert.rejects(readFile(join(dir, 'pool/test/auth.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
