import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { effortSchema, permissionModeSchema } from '@cc-desk-tunnel/protocol';
import { controlTlsOptions, openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
import { clearConfig, configDirectory, desktopLogin, loadConfig, saveConfig } from './config.mjs';
import { openConnection } from './connection.mjs';
import { environmentProxy } from './environment.mjs';
import manifest from '../package.json' with { type: 'json' };
import { attachTerminal, TERMINAL_RESET } from './terminal.mjs';

const USAGE = `用法：
  ccdt [目录]            在目录（默认当前目录）上打开远端原版 Claude Code
  ccdt login             保存服务地址、证书指纹和服务凭据
  ccdt logout            删除保存的连接信息
  ccdt --help | --version

选项：
  -n, --new                      新建会话，而不是接着用这个目录最近的会话
  -m, --model <模型>             会话模型
      --effort <强度>            low / medium / high / xhigh / max
      --permission-mode <模式>   auto / default / plan / acceptEdits

login 选项：--url <wss://…> --fingerprint <SHA256> --token-stdin（从标准输入读凭据）

环境变量：CCDT_TOKEN 覆盖保存的凭据；https_proxy / no_proxy 设定代理。
同一服务同时只运行一个原生终端或运行；桌面客户端占用时会提示忙。`;

const status = (text) => process.stderr.write(`\r\x1b[2K\x1b[2m${text}\x1b[0m`);
const clearStatus = () => process.stderr.write('\r\x1b[2K');

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        new: { type: 'boolean', short: 'n' },
        model: { type: 'string', short: 'm' },
        effort: { type: 'string' },
        'permission-mode': { type: 'string' },
        url: { type: 'string' },
        fingerprint: { type: 'string' },
        'token-stdin': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) return (console.log(USAGE), 0);
  if (values.version) return (console.log(manifest.version), 0);
  try {
    if (positionals[0] === 'login') return await login(values);
    if (positionals[0] === 'logout') {
      console.log((await clearConfig()) ? '已删除保存的连接信息。' : '没有保存的连接信息。');
      return 0;
    }
    if (positionals.length > 1) throw new UsageError('只能指定一个目录。');
    return await run(positionals[0] ?? '.', values);
  } catch (error) {
    clearStatus();
    console.error(
      error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `ccdt：${error.message}`,
    );
    return error instanceof UsageError ? 2 : 1;
  }
}
class UsageError extends Error {}

function validate({ url, fingerprint, token }) {
  const address = new URL(url);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('服务地址需要是不含凭据的 wss:// 地址。');
  controlTlsOptions({ fingerprint });
  if (token.length < 24) throw new Error('服务凭据至少 24 个字符。');
}

async function login(values) {
  const defaults = await desktopLogin();
  let { url, fingerprint } = values;
  let token = '';
  if (values['token-stdin']) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    token = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (url === undefined || fingerprint === undefined || !token) {
    if (!process.stdin.isTTY)
      throw new Error('非交互使用时请提供 --url、--fingerprint 和 --token-stdin。');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ask = async (question, fallback) =>
        (
          await prompt.question(fallback ? `${question} [${fallback}]：` : `${question}：`)
        ).trim() || fallback;
      url ??= await ask('服务地址（wss://…）', defaults.url);
      fingerprint ??= await ask('证书 SHA256 指纹（留空用 CA 验证）', defaults.fingerprint);
    } finally {
      prompt.close();
    }
    token ||= await askSecret('服务凭据（不回显）：');
  }
  validate({ url, fingerprint, token });
  const where = await saveConfig({ url, fingerprint, token });
  console.log(
    where === 'keyring'
      ? '已保存。服务凭据存入系统密钥环。'
      : `已保存。系统密钥环不可用，服务凭据存入仅本用户可读的 ${configDirectory()}/cli.json。`,
  );
  console.log('Claude 账号登录在终端里用 /login 完成。');
  return 0;
}

// Reads a line from the terminal without echoing it.
function askSecret(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let text = '';
    process.stderr.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (error) => {
      input.off('data', read);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(text.trim());
    };
    const read = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return done();
        if (character === '\x03') return done(new Error('已取消。'));
        if (character === '\x7f' || character === '\b') text = text.slice(0, -1);
        else if (character >= ' ') text += character;
      }
    };
    input.on('data', read);
  });
}

async function run(directory, values) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('需要在交互式终端里运行。');
  const permissionMode = values['permission-mode'];
  if (permissionMode !== undefined && !permissionModeSchema.safeParse(permissionMode).success)
    throw new UsageError(`未知审批模式：${permissionMode}`);
  if (values.effort !== undefined && !effortSchema.safeParse(values.effort).success)
    throw new UsageError(`未知推理强度：${values.effort}`);
  const projectPath = await realpath(resolve(directory)).catch(() => {
    throw new Error(`目录不存在：${directory}`);
  });
  if (!(await stat(projectPath)).isDirectory()) throw new Error(`不是目录：${projectPath}`);
  const config = await loadConfig();
  if (!config) throw new Error('尚未配置服务，请先运行 ccdt login。');
  if (!config.token)
    throw new Error('找不到服务凭据（密钥环可能已锁定）；请运行 ccdt login 或设置 CCDT_TOKEN。');

  // Until the terminal is attached, Ctrl+C and hang-ups stop the connection attempt and clean up the SSH endpoint.
  const abort = new AbortController();
  let terminal;
  const stop = () => (terminal ? terminal.close() : abort.abort());
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  let bridge, connection;
  try {
    status(`连接 ${new URL(config.url).host} …`);
    bridge = await openProxyBridge(
      { url: config.url, fingerprint: config.fingerprint },
      { resolveProxy: async (target) => environmentProxy(target) },
    );
    abort.signal.throwIfAborted();
    status('建立本机执行通道 …');
    connection = await Promise.race([
      openConnection(bridge.url, config.token),
      new Promise((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error('已取消。'))),
      ),
    ]);
    if (connection.ready.adapter !== 'claude-code')
      throw new Error('服务运行在离线模拟模式，没有原生终端。');
    const session = await chooseSession(connection, projectPath, values);
    abort.signal.throwIfAborted();
    clearStatus();
    terminal = attachTerminal(connection, session.id);
    let code;
    try {
      code = await terminal.exited;
    } catch (error) {
      process.stdout.write(TERMINAL_RESET);
      throw error;
    }
    return code ?? 0;
  } finally {
    for (const signal of signals) process.off(signal, stop);
    connection?.close();
    await bridge?.close();
  }
}

// The most recently used session of the directory, or a new one.
export async function chooseSession(connection, projectPath, values) {
  let session = values.new
    ? undefined
    : connection.ready.sessions
        .filter((candidate) => candidate.projectPath === projectPath)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!session) {
    const { sessionId } = await connection.request({
      type: 'session.create',
      title: basename(projectPath).slice(0, 120) || projectPath.slice(-120),
      projectPath,
    });
    session = {
      id: sessionId,
      title: basename(projectPath) || projectPath,
      permissionMode: 'auto',
    };
  }
  if (
    values.model !== undefined ||
    values.effort !== undefined ||
    values['permission-mode'] !== undefined
  )
    await connection.request({
      type: 'session.configure',
      sessionId: session.id,
      permissionMode: values['permission-mode'] ?? session.permissionMode,
      ...(values.model !== undefined && { model: values.model }),
      ...(values.effort !== undefined && { effort: values.effort }),
    });
  return session;
}
