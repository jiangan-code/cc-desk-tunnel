import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const maxAge = 15 * 60 * 1000;
const pool = () =>
  resolve(process.env.CCDT_CODEX_POOL || join(homedir(), '.local/share/ccdt/codex-pool'));
const home = (name) => {
  if (!namePattern.test(name || '')) throw new Error('Invalid account name.');
  return join(pool(), name);
};
const readJson = async (path) => {
  const contents = await readFile(path, 'utf8');
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error('Invalid JSON file.');
  }
};

export function parseQuota(data, now = Date.now()) {
  if (data.rate_limit?.allowed === false || data.rate_limit?.limit_reached === true)
    throw new Error('Account is rate limited.');
  const window = (value) => {
    if (
      !value ||
      typeof value.used_percent !== 'number' ||
      !Number.isFinite(value.used_percent) ||
      value.used_percent < 0 ||
      value.used_percent > 100
    )
      throw new Error('Invalid quota window.');
    const reset =
      value.reset_at ??
      (typeof value.reset_after_seconds === 'number'
        ? now / 1000 + value.reset_after_seconds
        : null);
    if (reset !== null && (typeof reset !== 'number' || !Number.isFinite(reset) || reset < 0))
      throw new Error('Invalid reset time.');
    return {
      remaining: 100 - value.used_percent,
      resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    };
  };
  return {
    fiveHour: window(data.rate_limit?.primary_window),
    weekly: window(data.rate_limit?.secondary_window),
    fetchedAt: new Date(now).toISOString(),
  };
}

export function pickAccount(accounts, now = Date.now()) {
  return (
    accounts
      .filter(({ quota }) => {
        const age = now - Date.parse(quota?.fetchedAt);
        return (
          age >= 0 &&
          age <= maxAge &&
          quota.fiveHour?.remaining > 0 &&
          quota.fiveHour.remaining <= 100 &&
          quota.weekly?.remaining > 5 &&
          quota.weekly.remaining <= 100
        );
      })
      .sort(
        (a, b) =>
          b.quota.fiveHour.remaining - a.quota.fiveHour.remaining ||
          b.quota.weekly.remaining - a.quota.weekly.remaining ||
          a.name.localeCompare(b.name),
      )[0] ?? null
  );
}

async function names() {
  try {
    return (await readdir(pool(), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && namePattern.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function list() {
  return Promise.all(
    (await names()).map(async (name) => {
      let quota = null;
      try {
        quota = await readJson(join(home(name), 'quota.json'));
      } catch {
        /* No valid snapshot. */
      }
      return { name, codexHome: home(name), quota };
    }),
  );
}
async function importAuth(name, auth) {
  if (!auth?.tokens?.access_token || !auth.tokens.id_token)
    throw new Error('Expected a ChatGPT OAuth auth.json with access_token and id_token.');
  const dir = home(name);
  await mkdir(pool(), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  try {
    await writeFile(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
async function refresh(name) {
  const dir = home(name);
  // Remove stale data before the request, including on authentication or network failure.
  await rm(join(dir, 'quota.json'), { force: true });
  const auth = await readJson(join(dir, 'auth.json'));
  if (!auth.tokens?.access_token) throw new Error('Account has no OAuth access token.');
  const headers = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    originator: 'Codex Desktop',
    'User-Agent': 'Codex Desktop/1.0 (linux; x64)',
    Accept: 'application/json',
  };
  if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Quota request failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (body.account_id && auth.tokens.account_id && body.account_id !== auth.tokens.account_id)
    throw new Error('Quota account identity mismatch.');
  const quota = parseQuota(body);
  await writeFile(join(dir, 'quota.json'), JSON.stringify(quota), { mode: 0o600 });
  await chmod(join(dir, 'quota.json'), 0o600);
  return quota;
}

export async function codexPool(args) {
  const [command, ...rest] = args;
  if (command === 'list' && !rest.length) console.log(JSON.stringify(await list()));
  else if (command === 'import' && rest.length === 2) {
    const [name, source] = rest;
    const path = source === 'current' ? join(homedir(), '.codex', 'auth.json') : resolve(source);
    await importAuth(name, await readJson(path));
    console.log(JSON.stringify({ name, codexHome: home(name) }));
  } else if (command === 'import-cockpit' && rest.length === 2) {
    const [name, path] = rest;
    const account = await readJson(resolve(path));
    await importAuth(name, {
      auth_mode: 'chatgpt',
      tokens: { ...account.tokens, account_id: account.account_id },
      ...(account.last_refresh ? { last_refresh: account.last_refresh } : {}),
    });
    console.log(JSON.stringify({ name, codexHome: home(name) }));
  } else if (command === 'remove' && rest.length === 1) {
    const dir = home(rest[0]);
    if (!(await names()).includes(rest[0])) throw new Error('Account not found.');
    await rm(dir, { recursive: true });
  } else if (command === 'refresh' && rest.length <= 1) {
    const selected = rest.length ? rest : await names();
    let failed = false;
    for (const name of selected) {
      try {
        console.log(JSON.stringify({ name, quota: await refresh(name) }));
      } catch {
        failed = true;
        console.error(`Quota refresh failed for ${name}.`);
      }
    }
    if (failed) return 1;
  } else if (
    command === 'pick' &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === '--env'))
  ) {
    const selected = pickAccount(await list());
    if (!selected) throw new Error('No account has usable recent quota; refresh the pool.');
    if (rest[0] === '--env') console.log(`CODEX_HOME=${selected.codexHome}`);
    else console.log(JSON.stringify(selected));
  } else
    throw new Error(
      'Usage: ccdt codex-pool list | import NAME current|AUTH_FILE | import-cockpit NAME DETAIL_FILE | remove NAME | refresh [NAME] | pick [--env]',
    );
  return 0;
}
