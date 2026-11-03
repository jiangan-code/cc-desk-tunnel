import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshProjectSkills, skillListCommand } from '../src/project-skills.ts';

const ssh = {
  configPath: '/tmp/ssh config',
  powershellPath: '/bin/bash',
  platform: 'linux' as const,
};

test('forwards only metadata from symlinked skills, refreshes, and isolates projects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "desktop's project");
  const actual = join(project, '.agents', 'skills');
  await mkdir(join(actual, 'hello'), { recursive: true });
  await mkdir(join(project, '.claude'), { recursive: true });
  await symlink('../.agents/skills', join(project, '.claude', 'skills'));
  await writeFile(
    join(actual, 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: >-\n  Say hello\n  to everyone.\nsecret: PRIVATE_FRONTMATTER\n---\nPRIVATE_BODY\n',
  );
  await writeFile(join(actual, 'hello', 'secret.txt'), 'PRIVATE_RESOURCE');
  const listing = () =>
    execFileSync('bash', ['-c', skillListCommand(project, ssh)], { encoding: 'utf8' });
  await mkdir(join(actual, 'broken'));
  await writeFile(
    join(actual, 'broken', 'SKILL.md'),
    '---\ndescription: |\n  PRIVATE_UNCLOSED_BODY\n',
  );
  const raw = listing();
  assert.doesNotMatch(raw, /PRIVATE/);
  assert.doesNotMatch(Buffer.from(raw.split('\t')[1], 'base64').toString(), /PRIVATE/);
  const cwd = join(root, 'session-a');
  await refreshProjectSkills(cwd, project, ssh, async () => raw);
  const wrapper = await readFile(join(cwd, '.claude', 'skills', 'hello', 'SKILL.md'), 'utf8');
  assert.match(wrapper, /Say hello to everyone/);
  assert.match(wrapper, /desktop's project/);
  assert.doesNotMatch(wrapper, /PRIVATE/);
  const other = join(root, 'session-b');
  await refreshProjectSkills(other, '/another project', ssh, async () => '');
  assert.deepEqual(await readdir(join(other, '.claude', 'skills')), []);
  await rm(join(actual, 'hello'), { recursive: true });
  await refreshProjectSkills(cwd, project, ssh, async () => listing());
  assert.deepEqual(await readdir(join(cwd, '.claude', 'skills')), []);
});

test('preserves unrelated local skills and removes stale wrappers when SSH fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const listing = `one\t${Buffer.from('name: one\ndescription: test').toString('base64')}\n`;
  await refreshProjectSkills(root, '/desktop', ssh, async () => listing);
  await mkdir(join(root, '.claude', 'skills', 'local'));
  await assert.rejects(
    refreshProjectSkills(root, '/desktop', ssh, async () => {
      throw new Error('offline');
    }),
  );
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['local']);
});

test('Windows discovery encodes a literal project path and selects only metadata', () => {
  const command = skillListCommand("C:\\O'Brien project", {
    ...ssh,
    platform: 'win32',
    powershellPath: 'C:\\Program Files\\pwsh.exe',
  });
  const encoded = command.split(' ').at(-1)!;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /O''Brien project/);
  assert.match(script, /\^\(name\|description\):/);
});

test('serializes refreshes sharing a native history directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondStarted = false;
  const first = refreshProjectSkills(root, '/desktop', ssh, async () => {
    await gate;
    return `old\t${Buffer.from('description: old').toString('base64')}\n`;
  });
  const second = refreshProjectSkills(root, '/desktop', ssh, async () => {
    secondStarted = true;
    return `new\t${Buffer.from('description: new').toString('base64')}\n`;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['new']);
});
