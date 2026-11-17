import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deviceIdentitySchema } from '@cc-desk-tunnel/protocol';

// A durable installation identity, separate from every temporary connection ID.
// Publish a complete file atomically; concurrent CLI invocations must agree on one identity.
export async function loadDeviceIdentity(path) {
  const read = async () => {
    const identity = deviceIdentitySchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return identity;
  };
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('设备身份文件损坏；请恢复备份，不要自动生成替代身份。');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const identity = { id: randomUUID(), key: randomBytes(32).toString('base64url') };
  try {
    await writeFile(temporary, JSON.stringify(identity) + '\n', { mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return read();
}
