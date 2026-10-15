import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { terminalIdentity, rememberTerminalIdentity } from '../src/terminal-identity.ts';

test('recovery never falls back to creating a new native conversation', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-identity-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(terminalIdentity(cwd, true, true), /不会另开对话/);
  const first = await terminalIdentity(cwd);
  assert.equal(first.continued, false);
  await assert.rejects(terminalIdentity(cwd, true, true), /不会另开对话/);
  assert.equal(await readFile(join(cwd, '.ccdt-terminal-session'), 'utf8'), first.id);
  const switched = randomUUID();
  rememberTerminalIdentity(
    cwd,
    JSON.stringify({ session_id: switched, tool_input: 'not retained' }),
  );
  assert.equal(await readFile(join(cwd, '.ccdt-terminal-session'), 'utf8'), switched);
  rememberTerminalIdentity(cwd, '{');
  rememberTerminalIdentity(cwd, JSON.stringify({ session_id: '../bad' }));
  assert.equal(await readFile(join(cwd, '.ccdt-terminal-session'), 'utf8'), switched);
});
