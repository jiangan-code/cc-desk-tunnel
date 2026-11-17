import { builtinModules } from 'node:module';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = join(root, '.local/cli-package');
const app = join(staging, 'ccdt');
const output = join(root, 'artifacts/cli');
const version = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version;
await build({
  configFile: false,
  root,
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node24',
    outDir: app,
    emptyOutDir: true,
    rolldownOptions: {
      input: join(root, 'apps/cli/bin/ccdt.mjs'),
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'ssh2',
        'bufferutil',
        'utf-8-validate',
      ],
      output: { format: 'es', entryFileNames: 'ccdt.mjs', codeSplitting: false },
    },
  },
});
// Only SSH needs external dependencies. Exclude optional build-host native binaries.
for (const name of ['ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) {
  const target = join(app, 'node_modules', name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(root, 'node_modules', name), target, {
    recursive: true,
    filter: (path) => !path.endsWith('.node'),
  });
}
cpSync(join(root, 'scripts/install-cli.mjs'), join(app, 'install.mjs'));
for (const file of ['LICENSE', 'NOTICE']) cpSync(join(root, file), join(app, file));
writeFileSync(
  join(app, 'README.md'),
  readFileSync(join(root, 'docs/macos-cli.md'), 'utf8').replace(
    '../deploy/README.md',
    'https://github.com/jiangan-code/cc-desk-tunnel/blob/main/deploy/README.md',
  ),
);
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    { name: 'ccdt', version, private: true, type: 'module', engines: { node: '>=24 <25' } },
    null,
    2,
  ) + '\n',
);
mkdirSync(output, { recursive: true });
const archive = join(output, `ccdt-${version}-node.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', staging, 'ccdt']);
console.log(`Terminal client: ${archive}`);
