import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { SshConnection } from './tunnel.ts';

const exec = promisify(execFile);
const refreshes = new Map<string, Promise<void>>();
const marker = '.ccdt-forwarded';
const safeName = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Only the name and description fields cross SSH; neither the body nor other frontmatter is transferred.
export function skillListCommand(projectPath: string, ssh: SshConnection) {
  if (ssh.platform === 'linux') {
    const script = `for d in "$1"/.claude/skills/*; do
  [ -f "$d/SKILL.md" ] || continue
  n=\${d##*/}
  printf '%s\\t' "$n"
  awk 'NR==1 {if ($0 != "---" && $0 != "---\\r") exit; next} /^---\\r?$/ {printf "%s", result; exit} /^[^[:space:]]/ {keep=($0 ~ /^(name|description):/)} keep {result=result $0 "\\n"}' "$d/SKILL.md" | base64 | tr -d '\\n'
  printf '\\n'
done`;
    return `bash -c ${quote(script)} -- ${quote(projectPath)}`;
  }
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Join-Path '${projectPath.replaceAll("'", "''")}' '.claude/skills'
if (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
    $file = Join-Path $_.FullName 'SKILL.md'
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $reader = [IO.File]::OpenText($file)
      try {
        $first = $reader.ReadLine(); $keep = $false; $lines = @(); $line = $null
        if ($first -eq '---') {
          while (($line = $reader.ReadLine()) -ne $null -and $line -ne '---') {
            if ($line -match '^\\S') { $keep = $line -match '^(name|description):' }
            if ($keep) { $lines += $line }
          }
        }
        if ($line -ne '---') { return }
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($lines -join "\`n")))
        Write-Output ($_.Name + "\`t" + $encoded)
      } finally { $reader.Dispose() }
    }
  }
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `"${ssh.powershellPath.replaceAll('"', '')}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

export async function refreshProjectSkills(
  cwd: string,
  projectPath: string,
  ssh: SshConnection,
  fetch = async () =>
    (
      await exec('ssh', ['-F', ssh.configPath, 'windows', skillListCommand(projectPath, ssh)], {
        timeout: 35000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout,
) {
  const previous = refreshes.get(cwd) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeWrappers(cwd, projectPath, ssh, fetch));
  refreshes.set(cwd, current);
  try {
    await current;
  } finally {
    if (refreshes.get(cwd) === current) refreshes.delete(cwd);
  }
}

async function writeWrappers(
  cwd: string,
  projectPath: string,
  ssh: SshConnection,
  fetch: () => Promise<string>,
) {
  const skills = join(cwd, '.claude', 'skills');
  await mkdir(skills, { recursive: true, mode: 0o700 });
  // Remove only wrappers created by this service, including when the desktop is unreachable.
  for (const name of await readdir(skills)) {
    const dir = join(skills, name);
    try {
      if ((await readFile(join(dir, marker), 'utf8')) === 'ccdt\n')
        await rm(dir, { recursive: true, force: true });
    } catch {
      /* Not a wrapper. */
    }
  }
  const stdout = await fetch();
  for (const line of stdout.split(/\r?\n/)) {
    const [directory, encoded] = line.split('\t');
    if (
      !directory ||
      directory === '.' ||
      directory === '..' ||
      /[\/\\\r\n]/.test(directory) ||
      !encoded
    )
      continue;
    let metadata: unknown;
    try {
      metadata = load(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (!metadata || typeof metadata !== 'object') continue;
    const { name, description } = metadata as Record<string, unknown>;
    const skillName = typeof name === 'string' ? name : directory;
    if (!safeName.test(skillName) || typeof description !== 'string' || !description.trim())
      continue;
    const dir = join(skills, skillName);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await writeFile(join(dir, marker), 'ccdt\n', { mode: 0o600 });
    const skillPath =
      ssh.platform === 'linux'
        ? `${projectPath.replace(/\/$/, '')}/.claude/skills/${directory}/SKILL.md`
        : `${projectPath.replace(/[\\/]$/, '')}\\.claude\\skills\\${directory}\\SKILL.md`;
    const text = `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\nRead the complete skill file ${JSON.stringify(skillPath)} on the desktop over SSH using the session's remote-work instructions. Follow that file and read any referenced files on the desktop over SSH. Pass the user's arguments to the skill.\n`;
    await writeFile(join(dir, 'SKILL.md'), text, { mode: 0o600 });
  }
}
