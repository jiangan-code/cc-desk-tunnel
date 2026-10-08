import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Linux desktop packaging currently supports x86_64.');
const vendor = fileURLToPath(new URL('../apps/desktop/vendor/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'cc-desktop-frp-'));
const archive = 'frp_0.71.0_linux_amd64.tar.gz';
try {
  const response = await fetch(
    `https://github.com/fatedier/frp/releases/download/v0.71.0/${archive}`,
    { signal: AbortSignal.timeout(300000) },
  );
  if (!response.ok) throw new Error(`frp download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (
    createHash('sha256').update(data).digest('hex') !==
    '84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716'
  )
    throw new Error('frp SHA256 mismatch');
  await writeFile(join(temporary, archive), data);
  execFileSync('tar', ['-xzf', join(temporary, archive), '-C', temporary]);
  await mkdir(vendor, { recursive: true });
  await copyFile(join(temporary, 'frp_0.71.0_linux_amd64/frpc'), join(vendor, 'frpc'));
  await chmod(join(vendor, 'frpc'), 0o755);
  await copyFile(join(temporary, 'frp_0.71.0_linux_amd64/LICENSE'), join(vendor, 'frp-LICENSE'));
  console.log('Verified Linux frpc installed. No system service was changed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
