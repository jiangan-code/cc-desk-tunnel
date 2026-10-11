import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHOWN = 8;

export const tilde = (path, home) =>
  path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
export const untilde = (path, home) =>
  path === '~' || path.startsWith('~/') ? home + path.slice(1) : path;

// Directories to offer for what has been typed into the new-agent form: the known project directories, most recent
// first, that contain it, then the subdirectories that complete its last part. Written as typed, with ~ for home.
export async function directoryCandidates(typed, { home, cwd, recent = [] }) {
  const needle = typed.toLowerCase();
  const found = new Set(
    recent.map((path) => tilde(path, home)).filter((path) => path.toLowerCase().includes(needle)),
  );
  const slash = typed.lastIndexOf('/');
  if (slash >= 0) {
    const base = typed.slice(0, slash + 1);
    const prefix = typed.slice(slash + 1).toLowerCase();
    const directory = resolve(cwd, untilde(base, home));
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {}
    const names = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
      if (!entry.name.toLowerCase().startsWith(prefix)) continue;
      const folder =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(join(directory, entry.name)).then(
            (target) => target.isDirectory(),
            () => false,
          )));
      if (folder) names.push(entry.name);
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) found.add(base + name);
  }
  return [...found].slice(0, SHOWN);
}

// The title for a new session: the wanted one, numbered when another session already has it.
export function freshTitle(wanted, taken) {
  if (!taken.has(wanted)) return wanted;
  for (let number = 2; ; number++)
    if (!taken.has(`${wanted} ${number}`)) return `${wanted} ${number}`;
}
