import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_PROFILE_PATTERN, DEFAULT_ACCOUNT_PROFILE } from '@cc-desk-tunnel/protocol';

// Each Claude account beyond the default one is a CLI configuration directory of its own (`CLAUDE_CONFIG_DIR`) under
// `root`, holding its sign-in, settings and CLI state. Conversations stay shared: its `projects` links to the default
// directory's, where the proxy finds, resumes, renames and deletes native sessions. The proxy remembers which
// account new CLI processes use; a process keeps the account it started with.
export class AccountProfiles {
  private stateFile: string;
  readonly root: string;
  readonly defaultDirectory: string;
  constructor(
    stateFile: string,
    root = join(homedir(), '.claude-accounts'),
    defaultDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  ) {
    this.stateFile = stateFile;
    this.root = root;
    this.defaultDirectory = defaultDirectory;
  }
  list(): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ACCOUNT_PROFILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .filter((name) => name !== DEFAULT_ACCOUNT_PROFILE)
        .sort();
    } catch {}
    return [DEFAULT_ACCOUNT_PROFILE, ...names];
  }
  has(profile: string) {
    return this.list().includes(profile);
  }
  // A remembered account whose directory was removed falls back to the default one.
  get active(): string {
    try {
      const { profile } = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (typeof profile === 'string' && this.has(profile)) return profile;
    } catch {}
    return DEFAULT_ACCOUNT_PROFILE;
  }
  use(profile: string) {
    if (!this.has(profile)) throw new Error(`Unknown account profile ${profile}`);
    writeFileSync(`${this.stateFile}.next`, JSON.stringify({ profile }) + '\n', { mode: 0o600 });
    renameSync(`${this.stateFile}.next`, this.stateFile);
  }
  // A new account starts from a copy of the default settings and the shared conversations.
  add(profile: string) {
    if (!ACCOUNT_PROFILE_PATTERN.test(profile) || profile === DEFAULT_ACCOUNT_PROFILE)
      throw new Error(`Invalid account profile ${profile}`);
    const directory = join(this.root, profile);
    if (existsSync(directory)) throw new Error(`Account profile ${profile} exists`);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    const projects = join(this.defaultDirectory, 'projects');
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    symlinkSync(projects, join(directory, 'projects'));
    const settings = join(this.defaultDirectory, 'settings.json');
    if (existsSync(settings)) copyFileSync(settings, join(directory, 'settings.json'));
  }
  // The CLI configuration directory; undefined for the default account, which the CLI finds by itself.
  directory(profile: string) {
    return profile === DEFAULT_ACCOUNT_PROFILE ? undefined : join(this.root, profile);
  }
  // Added to the environment of a CLI process that runs as this account.
  environment(profile: string): Record<string, string> {
    const directory = this.directory(profile);
    return directory ? { CLAUDE_CONFIG_DIR: directory } : {};
  }
}
