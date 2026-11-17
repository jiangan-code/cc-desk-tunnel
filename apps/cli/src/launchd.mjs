import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const LAUNCH_LABEL = 'io.github.ccdesktunnel.cli';
const exec = promisify(execFile);
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[character],
  );
export const launchLogPath = (home = homedir()) =>
  join(home, 'Library/Logs/cc-desk-tunnel/daemon.log');

// Use argv, never a shell command. Preserve tool paths and config location without copying secrets or proxies.
export function launchAgentFile({
  execPath = process.execPath,
  script = process.argv[1],
  env = process.env,
  home = homedir(),
} = {}) {
  const environment = Object.fromEntries(
    ['PATH', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'CCDT_NOTIFY']
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCH_LABEL}</string>
<key>ProgramArguments</key><array>${[execPath, script, 'daemon', 'run'].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join('')}</dict>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(launchLogPath(home))}</string>
<key>StandardErrorPath</key><string>${xml(launchLogPath(home))}</string>
</dict></plist>
`;
}

export async function manageLaunchAgent(
  command,
  { home = homedir(), uid = process.getuid(), run = exec, ...options } = {},
) {
  const domain = `gui/${uid}`;
  const target = `${domain}/${LAUNCH_LABEL}`;
  const path = join(home, 'Library/LaunchAgents', `${LAUNCH_LABEL}.plist`);
  const launchctl = (...args) => run('/bin/launchctl', args);
  const unload = async () => {
    try {
      await launchctl('bootout', target);
    } catch (error) {
      // launchctl reports ESRCH when the service is not loaded. Keep other failures visible.
      if (error.code !== 3 && error.code !== 113) throw error;
    }
  };
  if (command === 'status') {
    try {
      await launchctl('print', target);
      return 'loaded';
    } catch (error) {
      if (error.code !== 3 && error.code !== 113) throw error;
      return 'inactive';
    }
  }
  if (command === 'stop' || command === 'uninstall') {
    await unload();
    if (command === 'uninstall') await rm(path, { force: true });
    return;
  }
  if (command !== 'install') throw new Error('Unknown launchd operation');
  await mkdir(join(path, '..'), { recursive: true });
  await mkdir(join(launchLogPath(home), '..'), { recursive: true, mode: 0o700 });
  await writeFile(launchLogPath(home), '', { flag: 'a', mode: 0o600 });
  await writeFile(path, launchAgentFile({ ...options, home }), { mode: 0o600 });
  await unload();
  await launchctl('enable', target);
  await launchctl('bootstrap', domain, path);
  return path;
}
