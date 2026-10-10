import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../src/native-profiles.ts';

test('further accounts get their own CLI directory and share the conversations of the default one', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'proxy-profiles-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const defaults = join(base, 'claude');
  mkdirSync(defaults);
  writeFileSync(join(defaults, 'settings.json'), '{"theme":"dark"}\n');
  mkdirSync(join(defaults, 'skills'));
  const profiles = new AccountProfiles(
    join(base, 'account.json'),
    join(base, 'accounts'),
    defaults,
  );

  assert.deepEqual(profiles.list(), ['default']);
  assert.equal(profiles.active, 'default');
  assert.deepEqual(profiles.environment('default'), {});

  profiles.add('work');
  const directory = join(base, 'accounts', 'work');
  assert.equal(readlinkSync(join(directory, 'projects')), join(defaults, 'projects'));
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
  assert.equal(readlinkSync(join(directory, 'skills')), join(defaults, 'skills'));
  assert.equal(existsSync(join(directory, 'agents')), false);
  assert.deepEqual(profiles.environment('work'), { CLAUDE_CONFIG_DIR: directory });
  assert.throws(() => profiles.add('work'));
  assert.throws(() => profiles.add('default'));
  assert.throws(() => profiles.add('../x'));

  // A directory made by hand counts; names the CLI-safe pattern rejects do not.
  mkdirSync(join(base, 'accounts', 'alt'));
  mkdirSync(join(base, 'accounts', 'Bad Name'));
  assert.deepEqual(profiles.list(), ['default', 'alt', 'work']);

  profiles.use('work');
  assert.equal(
    new AccountProfiles(join(base, 'account.json'), join(base, 'accounts')).active,
    'work',
  );
  assert.throws(() => profiles.use('missing'));
  // The remembered account went away: back to the default.
  rmSync(directory, { recursive: true });
  assert.equal(profiles.active, 'default');
});
