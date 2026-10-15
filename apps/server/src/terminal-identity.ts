import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { DomainError } from './errors.ts';

const identityPath = (cwd: string) => join(cwd, '.ccdt-terminal-session');
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

// Native hooks report identity after /clear and /resume. Never retain hook tool arguments or transcript content.
export function rememberTerminalIdentity(cwd: string, body: string) {
  if (body.length > 65536) return;
  try {
    const id: unknown = JSON.parse(body).session_id;
    if (validId(id)) writeFileSync(identityPath(cwd), id, { mode: 0o600 });
  } catch {
    // Older hooks and synthetic status posts carry no identity.
  }
}

export async function terminalIdentity(cwd: string, continued = false, recover = false) {
  if (recover) {
    if (!existsSync(identityPath(cwd)))
      throw new DomainError('native_missing', '没有原生终端恢复记录；不会另开对话。');
    const id = readFileSync(identityPath(cwd), 'utf8').trim();
    if (!validId(id) || !(await getSessionInfo(id, { dir: cwd })))
      throw new DomainError('native_missing', '原生对话尚未保存或已丢失；不会另开对话。');
    return { id, continued: true };
  }
  const latest = continued ? (await listSessions({ dir: cwd, limit: 1 }))[0] : undefined;
  const id = latest?.sessionId ?? randomUUID();
  writeFileSync(identityPath(cwd), id, { mode: 0o600 });
  return { id, continued: !!latest };
}
