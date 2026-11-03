import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SshConnection } from './tunnel.ts';

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const bridge = fileURLToPath(new URL('./hook-bridge.mjs', import.meta.url));

// The allowlist is exact desktop paths; no hook is fetched for an untrusted project.
export async function terminalHookSettings(
  project: string,
  ssh: SshConnection,
  trusted: string[],
  providerPath: string | undefined,
  outputPath: string,
  fetch = async () =>
    (
      await exec(
        'ssh',
        [
          '-F',
          ssh.configPath,
          'windows',
          `bash -c ${quote('if [ -f "$1/.claude/settings.json" ]; then cat -- "$1/.claude/settings.json"; else printf "{}"; fi')} -- ${quote(project)}`,
        ],
        { timeout: 35000, maxBuffer: 2 * 1024 * 1024 },
      )
    ).stdout,
) {
  if (ssh.platform !== 'linux' || !trusted.includes(project)) return undefined;
  const source = JSON.parse(await fetch());
  const settings = providerPath ? JSON.parse(await readFile(providerPath, 'utf8')) : {};
  const hooks = settings.hooks ?? {};
  for (const [event, groups] of Object.entries(source.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new Error('Invalid desktop hook groups');
    const forwarded = groups.map((group) => ({
      ...group,
      hooks: group.hooks.map((hook: Record<string, unknown>) => {
        if (
          hook.type !== 'command' ||
          typeof hook.command !== 'string' ||
          hook.args ||
          (hook.shell && hook.shell !== 'bash')
        )
          throw new Error('Unsupported desktop hook handler');
        const command = [
          process.execPath,
          bridge,
          ssh.configPath,
          project,
          hook.command,
          String(hook.asyncRewake === true),
        ]
          .map(quote)
          .join(' ');
        return { ...hook, command };
      }),
    }));
    hooks[event] = [...(hooks[event] ?? []), ...forwarded];
  }
  settings.hooks = hooks;
  await writeFile(outputPath, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
  return outputPath;
}
