import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const [config, project, command, rewake] = process.argv.slice(2);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const marker = `CCDT_HOOK_${randomBytes(24).toString('hex')}:`;
const script = `cd -- ${quote(project)} || exit 254\nexport CLAUDE_PROJECT_DIR=${quote(project)}\nbash -c ${quote(command)}\ns=$?\nprintf '${marker}%s\\n' "$s" >&2\nexit 0`;
const ssh = spawn('ssh', ['-F', config, 'windows', `bash -c ${quote(script)}`], {
  stdio: ['pipe', 'inherit', 'pipe'],
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.once(signal, () => {
    ssh.kill(signal);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
process.stdin.pipe(ssh.stdin);
ssh.stdin.on('error', () => {});
let tail = Buffer.alloc(0);
ssh.stderr.on('data', (chunk) => {
  tail = Buffer.concat([tail, chunk]);
  const keep = marker.length + 5;
  if (tail.length > keep) {
    process.stderr.write(tail.subarray(0, tail.length - keep));
    tail = tail.subarray(tail.length - keep);
  }
});
let error;
ssh.on('error', (e) => {
  error = e;
});
ssh.on('close', (code) => {
  const match = tail.toString('latin1').match(new RegExp(`${marker}([0-9]{1,3})\\n$`));
  if (code === 0 && match && Number(match[1]) <= 255) {
    process.stderr.write(tail.subarray(0, tail.length - match[0].length));
    process.exitCode = Number(match[1]);
  } else {
    process.stderr.write(tail);
    process.stderr.write(
      `ccdt hook bridge: SSH transport failed${error ? `: ${error.message}` : ''}\n`,
    );
    process.exitCode = rewake === 'true' ? 2 : 1;
  }
});
