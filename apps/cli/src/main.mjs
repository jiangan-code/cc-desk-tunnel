import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  ACCOUNT_PROFILE_PATTERN,
  effortSchema,
  permissionModeSchema,
} from '@cc-desk-tunnel/protocol';
import { controlTlsOptions, openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
import { clearConfig, configDirectory, desktopLogin, loadConfig, saveConfig } from './config.mjs';
import { openConnection } from './connection.mjs';
import {
  daemonRunning,
  daemonSocket,
  daemonStatus,
  installDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
} from './daemon.mjs';
import { environmentProxy } from './environment.mjs';
import manifest from '../package.json' with { type: 'json' };
import { Deck } from './deck.mjs';
import { herdrPane, herdrReporter } from './herdr.mjs';
import { attachTerminal, TERMINAL_RESET } from './terminal.mjs';

const USAGE = `用法：
  ccdt [目录]            在目录（默认当前目录）上打开远端原版 Claude Code
  ccdt deck [目录]       先打开 agent 列表
  ccdt ls [目录]         列出 agent 和它们此刻的状态（需要后台服务）；--json 输出 JSON
  ccdt accounts          列出服务端账号和登录状态；--json 输出 JSON，旧服务端退出码为 3
  ccdt rm <会话 ID>…     删除已停止的 agent 和它的对话（需要后台服务）
  ccdt daemon install    装成 systemd 用户服务：关掉终端 agent 也继续运行
  ccdt daemon status | stop | uninstall
  ccdt login             保存服务地址、证书指纹和服务凭据
  ccdt logout            删除保存的连接信息
  ccdt --help | --version

选项：
  -n, --new                      新建会话，而不是接着这个目录最近的对话
  -m, --model <模型>             会话模型
      --effort <强度>            low / medium / high / xhigh / max
      --permission-mode <模式>   auto / default / plan / acceptEdits
      --name <名字>              新建会话的名字（默认用目录名）
      --account <账号>           为本次打开的终端选择已登录账号，不改变服务端当前账号；省略则用当前账号
                                 续接已停止的会话时用此账号；运行中的终端保留原账号，不同则报错
      --single                   只跑这一个 agent，不显示列表：它退出时 ccdt 随之退出（退出码相同），
                                 ccdt 被结束（关掉终端、SIGTERM）时也结束这个 agent；Ctrl+Q 不再返回列表

login 选项：--url <wss://…> --fingerprint <SHA256> --token-stdin（从标准输入读凭据）

在 Claude Code 里按 Ctrl+Q 回到 agent 列表，agent 在服务端继续运行；列表里可以进入、新建、结束
和搜索 agent，有 agent 等你时会响铃并显示在窗口标题上。后台服务运行时，退出 ccdt 或关掉终端
agent 照常运行，任何终端里再运行 ccdt 都能接回；没有后台服务时，退出 ccdt 会结束全部 agent。

环境变量：CCDT_TOKEN 覆盖保存的凭据；https_proxy / no_proxy 设定代理。
同一服务同时只接受一台执行设备；桌面客户端已连接时会提示忙。`;

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
        name: { type: 'string' },
        account: { type: 'string' },
        single: { type: 'boolean' },
        json: { type: 'boolean' },
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
    if (values.account !== undefined && !ACCOUNT_PROFILE_PATTERN.test(values.account))
      throw new UsageError(
        '账号名只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 个字符。',
      );
    if (positionals[0] === 'login') return await login(values);
    if (positionals[0] === 'logout') {
      console.log((await clearConfig()) ? '已删除保存的连接信息。' : '没有保存的连接信息。');
      return 0;
    }
    if (positionals[0] === 'daemon') return await daemon(positionals[1]);
    if (positionals[0] === 'accounts') {
      if (positionals.length > 1) throw new UsageError('accounts 不接受目录或其他参数。');
      return await accounts(values);
    }
    if (positionals[0] === 'ls') {
      if (positionals.length > 2) throw new UsageError('只能指定一个目录。');
      return await list(positionals[1], values);
    }
    if (positionals[0] === 'rm') {
      if (positionals.length < 2) throw new UsageError('请给出要删除的会话 ID（见 ccdt ls）。');
      return await remove(positionals.slice(1));
    }
    const deck = positionals[0] === 'deck';
    if (deck) positionals.shift();
    if (positionals.length > 1) throw new UsageError('只能指定一个目录。');
    return await run(positionals[0] ?? '.', { ...values, deck });
  } catch (error) {
    clearStatus();
    console.error(
      error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `ccdt：${error.message}`,
    );
    return error instanceof UsageError ? 2 : (error.exitCode ?? 1);
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

async function daemon(command) {
  if (command === 'run') {
    const config = await loadConfig();
    if (!config?.token)
      throw new Error('没有可用的服务配置或凭据（密钥环可能已锁定）；请先运行 ccdt login。');
    const handle = await startDaemon({
      ...config,
      resolveProxy: async (target) => environmentProxy(target),
    });
    // systemd stops the daemon with SIGTERM; that ends the agents.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.once(signal, () => void handle.stop().then(() => process.exit(0)));
    throw new Error((await handle.ended) ?? '与服务的连接已结束。');
  }
  if (command === 'install') {
    if (!(await loadConfig())?.token) throw new Error('请先运行 ccdt login。');
    const path = await installDaemon();
    console.log(`已安装并启动后台服务：${path}`);
    console.log('它运行的命令使用本终端此刻的 PATH；PATH 变了就再运行一次 ccdt daemon install。');
    console.log(
      '之后运行 ccdt 会连到它；关掉终端 agent 也继续运行。日志：journalctl --user -u ccdt',
    );
    console.log('桌面会话退出后也要保持运行，可以执行：loginctl enable-linger');
    return 0;
  }
  if (command === 'uninstall') {
    await uninstallDaemon();
    console.log('已停止并移除后台服务。');
    return 0;
  }
  if (command === 'stop') {
    await stopDaemon();
    console.log('后台服务已停止，它运行的 agent 都已结束；对话都保留。');
    return 0;
  }
  if (command === 'status') {
    const state = await daemonStatus();
    const answering = await daemonRunning();
    console.log(
      answering ? `后台服务运行中（${state}），${daemonSocket()}` : `后台服务未运行（${state}）。`,
    );
    return answering ? 0 : 3;
  }
  throw new UsageError('daemon 子命令：install / status / stop / uninstall / run');
}

async function run(directory, values) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('需要在交互式终端里运行。');
  const permissionMode = values['permission-mode'];
  if (permissionMode !== undefined && !permissionModeSchema.safeParse(permissionMode).success)
    throw new UsageError(`未知审批模式：${permissionMode}`);
  if (values.effort !== undefined && !effortSchema.safeParse(values.effort).success)
    throw new UsageError(`未知推理强度：${values.effort}`);
  if (values.name !== undefined && !values.name.trim()) throw new UsageError('--name 不能为空。');
  if (values.single && values.deck) throw new UsageError('--single 不能和 deck 一起用。');
  const projectPath = await realpath(resolve(directory)).catch(() => {
    throw new Error(`目录不存在：${directory}`);
  });
  if (!(await stat(projectPath)).isDirectory()) throw new Error(`不是目录：${projectPath}`);
  // With the background daemon running, this ccdt is only a view: agents outlive it.
  const background = await daemonRunning();
  const config = await loadConfig();
  if (!background) {
    if (!config) throw new Error('尚未配置服务，请先运行 ccdt login。');
    if (!config.token)
      throw new Error('找不到服务凭据（密钥环可能已锁定）；请运行 ccdt login 或设置 CCDT_TOKEN。');
  }

  // Signals end ccdt: before the connection stands they stop the attempt; after, they close the connection, which
  // ends the agents (without the daemon) and lets the steps below clean up the terminal.
  const abort = new AbortController();
  let connection, bridge;
  // With --single the agent belongs to this ccdt, so a signal ends the agent first; the service reports it closed,
  // which settles the attach below. A service that never answers still lets ccdt go after 5 s.
  let single = null;
  const stop = () => {
    if (!single) return connection ? connection.close() : abort.abort();
    single.close();
    setTimeout(() => connection.close(), 5000).unref();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  let deck, herdr, unsubscribeHerdr;
  let terminalsNow = [];
  try {
    if (background) status('连接后台服务 …');
    else {
      status(`连接 ${new URL(config.url).host} …`);
      bridge = await openProxyBridge(
        { url: config.url, fingerprint: config.fingerprint },
        { resolveProxy: async (target) => environmentProxy(target) },
      );
      abort.signal.throwIfAborted();
      status('建立本机执行通道 …');
    }
    connection = await Promise.race([
      background
        ? openConnection(`ws+unix://${daemonSocket()}:/`, null)
        : openConnection(bridge.url, config.token),
      new Promise((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error('已取消。'))),
      ),
    ]);
    if (connection.ready.adapter !== 'claude-code')
      throw new Error('服务运行在离线模拟模式，没有原生终端。');
    if (values.account !== undefined) await checkAccount(connection, values.account);
    let lost = null;
    connection.closed.then((reason) => (lost = reason ?? '连接已断开。'));
    deck = new Deck(connection, {
      cwd: projectPath,
      host: config?.url ? new URL(config.url).host : '',
      background,
    });
    // Inside a Herdr pane, Herdr shows the state of the agent on screen.
    const pane = herdrPane();
    if (pane) {
      herdr = herdrReporter(pane);
      unsubscribeHerdr = connection.onMessage((message) => {
        if (message.type !== 'terminals.state') return;
        terminalsNow = message.terminals;
        herdr.update(terminalsNow);
      });
    }
    await connection.request({ type: 'terminal.list' });
    let attached = false;
    // A network drop pauses everything until the bridge has the connection back. The list says so on its message
    // line; an agent's screen belongs to Claude Code, so there the window title does.
    connection.onState((state, recovered) => {
      const reconnecting = state === 'reconnecting';
      if (attached)
        process.stdout.write(
          `\x1b]2;${reconnecting ? 'ccdt：网络中断，正在重连…' : recovered ? 'ccdt：已恢复同一对话，继续任务' : 'ccdt'}\x07`,
        );
      else if (deck.shown) deck.notice(reconnecting ? '网络中断，正在重连…' : '已重新连接。');
      else status(reconnecting ? '网络中断，正在重连 …' : '已重新连接 …');
    });
    let next = null;
    if (!values.deck) {
      const session = await chooseSession(connection, projectPath, values);
      next = { sessionId: session.id, continued: !values.new };
    }
    clearStatus();
    if (values.single) {
      attached = true;
      herdr?.attach(next.sessionId, terminalsNow);
      single = attachTerminal(connection, next.sessionId, {
        continued: next.continued,
        detachable: false,
        profile: values.account,
      });
      try {
        return (await single.exited).code ?? 0;
      } finally {
        attached = false;
        herdr?.detach();
        process.stdout.write(TERMINAL_RESET);
      }
    }
    let message = '';
    for (;;) {
      if (!next) {
        next = await deck.choose(message);
        if (next.lost) throw new Error(next.lost);
        if (next.quit) return 0;
      }
      const title = deck.sessions.get(next.sessionId)?.title ?? '';
      deck.attached = next.sessionId;
      attached = true;
      herdr?.attach(next.sessionId, terminalsNow);
      const terminal = attachTerminal(connection, next.sessionId, {
        continued: next.continued,
        profile: values.account,
      });
      let result;
      try {
        result = await terminal.exited;
      } catch (error) {
        if (lost || values.account !== undefined) throw error;
        result = { error: error.message };
      } finally {
        attached = false;
        herdr?.detach();
        deck.attached = null;
        process.stdout.write(TERMINAL_RESET + '\x1b[H\x1b[2J');
      }
      message = result.error
        ? `无法打开「${title}」：${result.error}`
        : result.detached
          ? ''
          : `「${title}」已退出${result.code ? `（代码 ${result.code}）` : ''}。按 Enter 可以接着这段对话。`;
      next = null;
    }
  } finally {
    deck?.hide();
    unsubscribeHerdr?.();
    herdr?.detach();
    await herdr?.settled();
    for (const signal of signals) process.off(signal, stop);
    connection?.close();
    await bridge?.close();
  }
}

// Account reads do not start agents; use the daemon's connection when it owns the execution device.
async function accounts(values) {
  let connection, bridge;
  try {
    if (await daemonRunning())
      connection = await openConnection(`ws+unix://${daemonSocket()}:/`, null);
    else {
      const config = await loadConfig();
      if (!config?.token) throw new Error('没有可用的服务配置或凭据；请先运行 ccdt login。');
      bridge = await openProxyBridge(
        { url: config.url, fingerprint: config.fingerprint },
        { resolveProxy: async (target) => environmentProxy(target) },
      );
      connection = await openConnection(bridge.url, config.token);
    }
    const state = await listAccounts(connection);
    if (values.json) console.log(JSON.stringify(state));
    else {
      console.log(`当前账号：${state.active}`);
      console.log('账号\t登录状态\t邮箱\t订阅');
      for (const account of state.accounts)
        console.log(
          [
            account.profile,
            account.loggedIn ? '已登录' : '未登录',
            account.email ?? '',
            account.subscriptionType ?? '',
          ].join('\t'),
        );
    }
    return 0;
  } finally {
    connection?.close();
    await bridge?.close();
  }
}

export async function listAccounts(connection, { timeoutMs = 10000 } = {}) {
  let unsubscribe, timer;
  const state = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('服务没有返回账号状态。')), timeoutMs);
    unsubscribe = connection.onMessage((message) => {
      if (message.type === 'account.state') resolve(message);
    });
  });
  try {
    const [, message] = await Promise.all([connection.request({ type: 'account.status' }), state]);
    if (message.profile === undefined || message.profiles === undefined) {
      const error = new Error('服务端不支持多账号，请升级并重新部署服务端。');
      error.exitCode = 3;
      throw error;
    }
    return { active: message.profile, accounts: message.profiles };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export async function checkAccount(connection, profile) {
  const { accounts } = await listAccounts(connection);
  const account = accounts.find((account) => account.profile === profile);
  if (!account) throw new Error(`没有账号 ${profile}。`);
  if (!account.loggedIn) throw new Error(`账号 ${profile} 尚未登录，请先登录这个账号。`);
}

// The most recently used session of the directory, or a new one.
export async function chooseSession(connection, projectPath, values) {
  let session = values.new
    ? undefined
    : connection.ready.sessions
        .filter((candidate) => candidate.projectPath === projectPath)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!session) {
    const title =
      values.name?.trim().slice(0, 120) ||
      basename(projectPath).slice(0, 120) ||
      projectPath.slice(-120);
    const { sessionId } = await connection.request({ type: 'session.create', title, projectPath });
    session = { id: sessionId, title, permissionMode: 'auto' };
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

// `ccdt ls`: the agents the list shows, with what each is doing now. Only through the daemon: a connection of its
// own would take the device's place and, when it closed, end the agents.
async function list(directory, values) {
  const projectPath =
    directory === undefined
      ? undefined
      : await realpath(resolve(directory)).catch(() => {
          throw new Error(`目录不存在：${directory}`);
        });
  if (!(await daemonRunning()))
    throw new Error('ccdt ls 需要后台服务；请先运行 ccdt daemon install。');
  const connection = await openConnection(`ws+unix://${daemonSocket()}:/`, null);
  try {
    const agents = await listAgents(connection, projectPath);
    if (values.json) console.log(JSON.stringify(agents));
    else
      for (const agent of agents)
        console.log([agent.status, agent.title, agent.projectPath, agent.id].join('\t'));
    return 0;
  } finally {
    connection.close();
  }
}

// `ccdt rm`: deletes agents the way the list does, through the daemon for the same reason as `ccdt ls`.
async function remove(ids) {
  if (!(await daemonRunning()))
    throw new Error('ccdt rm 需要后台服务；请先运行 ccdt daemon install。');
  const connection = await openConnection(`ws+unix://${daemonSocket()}:/`, null);
  try {
    for (const agent of await removeAgents(connection, ids))
      console.log(`已删除：${agent.title}\t${agent.id}`);
    return 0;
  } finally {
    connection.close();
  }
}

// Deletes sessions and their conversations, only once every one of them is stopped: a running agent is ended
// first, so a script cannot take a session from under a terminal. Nothing is deleted when any ID fails the check.
export async function removeAgents(connection, ids, options) {
  const agents = new Map(
    (await listAgents(connection, undefined, options)).map((agent) => [agent.id, agent]),
  );
  const chosen = [...new Set(ids)].map((id) => {
    const agent = agents.get(id);
    if (!agent) throw new Error(`没有这个会话：${id}`);
    if (agent.status !== 'stopped')
      throw new Error(`${agent.title}（${id}）还在运行（${agent.status}），先结束它再删除。`);
    return agent;
  });
  for (const agent of chosen)
    await connection.request({ type: 'session.delete', sessionId: agent.id });
  return chosen;
}

// Sessions (of one directory, when given) with their terminal's status: starting, busy, waiting or idle, and
// stopped when no terminal runs. Asks for `terminals.state`, the same report the list keeps itself current with.
export async function listAgents(connection, projectPath, { timeoutMs = 10000 } = {}) {
  let unsubscribe;
  const state = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务没有返回 agent 状态。')), timeoutMs);
    unsubscribe = connection.onMessage((message) => {
      if (message.type !== 'terminals.state') return;
      clearTimeout(timer);
      resolve(message.terminals);
    });
  });
  try {
    await connection.request({ type: 'terminal.list' });
    const terminals = new Map((await state).map((terminal) => [terminal.sessionId, terminal]));
    return connection.ready.sessions
      .filter((session) => projectPath === undefined || session.projectPath === projectPath)
      .map((session) => ({
        id: session.id,
        title: session.title,
        projectPath: session.projectPath,
        status: terminals.get(session.id)?.status ?? 'stopped',
        ...(terminals.get(session.id)?.profile !== undefined && {
          profile: terminals.get(session.id).profile,
        }),
      }));
  } finally {
    unsubscribe();
  }
}
