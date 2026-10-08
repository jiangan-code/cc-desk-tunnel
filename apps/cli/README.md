# Linux 终端客户端 `ccdt`

在你自己的终端里直接使用远端的原版 Claude Code：界面、快捷键和斜杠命令与本地 `claude` 一样，模型和会话在服务端，命令在本机当前目录执行。不需要图形界面和 Electron。

```bash
cd ~/code/myproject
ccdt               # 接着这个目录最近的会话；没有就新建
ccdt -n            # 新建会话
ccdt ~/other -m opus --effort high --permission-mode plan
```

Claude 账号登录、`/resume`、`/config` 等都在终端里用原版斜杠命令完成。退出 Claude Code（`/exit` 或两次 Ctrl+C）即断开连接并回收本机隧道。

## 安装与登录

安装 deb 桌面包后直接有 `/usr/bin/ccdt`，由包内的 Electron 以 Node 模式运行。从源码使用需要 Node.js 24：

```bash
npm ci
npm run install:cli      # 在 ~/.local/bin 放一个绑定本源码目录和当前 Node 的 ccdt 启动脚本
ccdt login               # 服务地址、证书指纹默认取自桌面客户端的保存值；凭据不回显
```

服务凭据优先存入系统密钥环（`secret-tool`，GNOME Keyring / KWallet）；密钥环不可用时存入 `~/.config/cc-desk-tunnel/cli.json`，权限 0600。也可以不保存，用 `CCDT_TOKEN` 环境变量提供。脚本化登录：`ccdt login --url wss://… --fingerprint … --token-stdin < token.txt`。

## 工作方式

`ccdt` 复用桌面客户端的连接桥 `apps/desktop/electron/proxy-bridge.mjs`：同样的 WSS 证书校验、经服务端 WSS 中继的执行通道（不需要 frpc 和额外端口，见 [Linux 桌面指南](../../docs/linux-desktop.md#执行通道)）和每次连接临时生成的纯 JS SSH（只提供非交互式 Bash exec）。之后它打开服务端已有的原生终端（`terminal.open`），把本机终端切到 raw 模式，按键作为 `terminal.input` 上传，`SIGWINCH` 时发送 `terminal.resize`，输出写入本机终端后再回 `terminal.ack`，服务端据此做流控。

- 目录到会话：按目录的真实路径匹配 `projectPath`，取最近更新的会话，与桌面客户端里同一项目的会话共用。
- 代理：读取 `https_proxy` / `all_proxy` 与 `no_proxy`，只支持 HTTP CONNECT 代理；回环地址总是直连。
- 同一服务同一时间只接受一台执行设备，也只有一个原生运行或终端；桌面客户端已连接时会提示“已有桌面设备连接”。
- 网络中断时终端暂停，窗口标题显示“正在重连”；3 分钟内恢复则接着用，Claude Code 一直在服务端运行，期间的输出和按键都会补上。超过 3 分钟则结束本次终端。见[断线续接](../../docs/linux-desktop.md#断线续接)。
- 异常断开时恢复本机终端状态（光标、括号粘贴、鼠标与焦点上报、备用屏幕）。

## 已知限制

- 终端会话的 CLI 历史与图形界面里的对话不互通（见[路线与现状](../../docs/roadmap.md)）。
- 不运行定时任务；定时任务仍由桌面客户端执行。
