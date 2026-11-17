import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Connection details follow XDG. macOS stores tokens in Keychain; Linux uses
// Secret Service with a private-file fallback.
export function configDirectory(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cc-desk-tunnel');
}
const configPath = (env) => join(configDirectory(env), 'cli.json');
const attributes = (url) => ['service', 'cc-desk-tunnel', 'url', url];

// Secret values travel through stdin, never in a process's argument list.
function runSecret(executable, args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30000,
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? output : null));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function secretTool(args, input, env = process.env) {
  return runSecret('secret-tool', args, input, env);
}

// security's interactive parser accepts quoted arguments and backslash escapes.
// One command followed by EOF preserves its exit status; a trailing "quit" would hide failures.
export async function macSecrets(args, input, env = process.env, run = runSecret) {
  const action = args[0];
  const account = args.at(-1);
  const match = ['-s', 'cc-desk-tunnel', '-a', account];
  if (action === 'lookup')
    return run('/usr/bin/security', ['find-generic-password', ...match, '-w'], '', env);
  if (action === 'clear')
    return run('/usr/bin/security', ['delete-generic-password', ...match], '', env);
  if (action !== 'store') return null;
  const values = ['add-generic-password', '-U', ...match, '-w', input];
  if (values.some((value) => typeof value !== 'string' || /[\r\n\0]/.test(value))) return null;
  const line =
    values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(' ') +
    '\n';
  if (Buffer.byteLength(line) >= 4096) return null;
  const result = await run('/usr/bin/security', ['-i'], line, env);
  if (result === null) return null;
  // Verify the complete value before removing any existing file-based credential.
  const saved = await run('/usr/bin/security', ['find-generic-password', ...match, '-w'], '', env);
  return saved?.replace(/\r?\n$/, '') === input ? '' : null;
}

const systemSecrets = (...args) =>
  (process.platform === 'darwin' ? macSecrets : secretTool)(...args);

export async function loadConfig(env = process.env, secrets = systemSecrets) {
  let saved;
  try {
    saved = JSON.parse(await readFile(configPath(env), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`配置文件无法读取：${configPath(env)}`);
  }
  if (typeof saved?.url !== 'string') return null;
  const token =
    env.CCDT_TOKEN?.trim() ||
    (typeof saved.token === 'string' && saved.token) ||
    (await secrets(['lookup', ...attributes(saved.url)], '', env))?.trim() ||
    '';
  return { url: saved.url, fingerprint: String(saved.fingerprint ?? ''), token };
}

// Returns where the token ended up: 'keyring' or 'file'.
export async function saveConfig(
  { url, fingerprint, token },
  env = process.env,
  secrets = systemSecrets,
  platform = process.platform,
) {
  const stored =
    (await secrets(
      ['store', '--label', `CC Desk Tunnel (${url})`, ...attributes(url)],
      token,
      env,
    )) !== null;
  if (!stored && platform === 'darwin')
    throw new Error('macOS 钥匙串无法保存凭据；请解锁登录钥匙串后重试。');
  const directory = configDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${configPath(env)}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ url, fingerprint, ...(!stored && { token }) }, null, 2) + '\n',
    { mode: 0o600 },
  );
  await rename(temporary, configPath(env));
  return stored ? 'keyring' : 'file';
}

export async function clearConfig(env = process.env, secrets = systemSecrets) {
  const saved = await loadConfig({ ...env, CCDT_TOKEN: '' }, async () => '').catch(() => null);
  if (saved) await secrets(['clear', ...attributes(saved.url)], '', env);
  await rm(configPath(env), { force: true });
  return !!saved;
}

// The desktop client's saved address and pin, offered as defaults. Its token is encrypted for Electron and stays there.
export async function desktopLogin(env = process.env) {
  try {
    const { login } = JSON.parse(
      await readFile(
        join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'CC Desk Tunnel/settings.json'),
        'utf8',
      ),
    );
    return { url: String(login?.url ?? ''), fingerprint: String(login?.fingerprint ?? '') };
  } catch {
    return { url: '', fingerprint: '' };
  }
}
