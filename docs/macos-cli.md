# Mac 终端版 ccdt（Apple Silicon arm64）

`ccdt` 在 Mac 终端里显示服务器上的原版 Claude Code。模型和会话在 Linux 服务端，项目文件和命令在 Mac。本机只运行 Node.js 与终端连接程序；后台模式由 macOS 自带的 launchd 托管。

## 轻量包安装

在新 Mac 安装 [Node.js 24 的 macOS ARM64 版本](https://nodejs.org/en/download)，确认 `node -p 'process.version + " " + process.arch'` 显示 `v24.x.x arm64`。

把 `ccdt-0.2.6-node.tar.gz` 放到下载目录，执行：

```bash
mkdir -p ~/.local/share/cc-desk-tunnel
tar -xzf ~/Downloads/ccdt-0.2.6-node.tar.gz -C ~/.local/share/cc-desk-tunnel
node ~/.local/share/cc-desk-tunnel/ccdt/install.mjs
export PATH="$HOME/.local/bin:$PATH"
ccdt login
ccdt daemon install
ccdt daemon status
```

如 `~/.local/bin` 尚未加入 PATH，在 `~/.zshrc` 中加入 `export PATH="$HOME/.local/bin:$PATH"`，新开终端后也能直接使用 `ccdt`。启动脚本绑定安装时的 Node 绝对路径；以后移动或删除该 Node 版本，需要重新运行 `install.mjs` 和 `ccdt daemon install`。

`ccdt login` 交互询问 WSS 服务地址、SHA256 指纹和服务凭据；凭据不回显。可信 CA 证书可以将指纹留空，自签证书填写服务器上确认的指纹。服务凭据存入 macOS 登录钥匙串，配置文件只存地址和指纹；钥匙串不可用时登录报错，解锁后重试。

**服务器必须已更新到支持 macOS 的本次代码。** 用随附的服务端升级包，在原部署目录执行：

```bash
sudo bash deploy/manage.sh upgrade --from /上传目录/cc-desk-tunnel-server.tar.gz
```

沿用原部署的数据和账号，备份与运维见[部署操作手册](../deploy/README.md)。0.2.6 支持多台新版设备同时在线；旧版混用与历史归属迁移见[多设备指南](multi-device.md)。

## 日常使用

```bash
cd ~/Projects/你的项目
ccdt                  # 接回当前目录最近的对话
ccdt -n               # 新建会话
ccdt deck             # 打开终端 agent 列表
ccdt ls --json        # 查看后台 agent 状态
```

按 `Ctrl+Q` 回到 agent 列表，agent 继续运行；按 `q` 离开列表或关闭终端，后台任务仍在。重新打开终端运行 `ccdt` 即可接回。`ccdt --single` 是脚本模式，关闭该终端会结束对应 agent。

后台服务随当前用户登录启动，网络中断时自动重连；超过续接宽限期后恢复同一原生对话。Mac 退出登录、关机或进入系统睡眠期间不会继续在本机执行命令；需要长时间任务时保持 Mac 唤醒。

```bash
ccdt daemon status
ccdt daemon stop       # 停止本次后台服务及其 agent；对话保留
ccdt daemon install    # 重新安装配置并启动；更换 PATH 或连接配置后也用此命令
ccdt daemon uninstall  # 停止并取消登录自启
tail -f ~/Library/Logs/cc-desk-tunnel/daemon.log
```

LaunchAgent 位于 `~/Library/LaunchAgents/io.github.ccdesktunnel.cli.plist`。只保存运行路径和必要的环境配置，凭据与代理密码不写入 plist。Unix socket 默认位于 `/tmp/ccdt-<用户UID>/ccdt.sock`，目录权限 0700、socket 权限 0600。

任务等待用户时使用终端提示音和 macOS 原生通知；`CCDT_NOTIFY=0` 关闭通知。要让后台也关闭通知，执行 `CCDT_NOTIFY=0 ccdt daemon install`。

Mac 的执行通道复用 WSS 中继和每次连接的临时 SSH 密钥。只连接服务端 WSS 入口，无需启用 macOS「远程登录」、安装 frpc 或开放 Mac 入站端口。Homebrew 的 `/opt/homebrew/bin` 和用户 `~/.local/bin` 自动加入命令环境；安装后台服务时保留终端 PATH。仅在 `.zshrc` 里初始化的 nvm 等环境，需在具体项目命令中显式初始化。

## 从源码安装或构建轻量包

源码安装：

```bash
npm ci
npm run install:cli
ccdt login
ccdt daemon install
```

维护者在已有依赖的源码目录执行 `npm run package:cli`，生成 `artifacts/cli/ccdt-<版本>-node.tar.gz`。包内为编译后的纯 JavaScript 和 SSH 的纯 JavaScript 依赖，可在 Mac/Linux 的 Node.js 24 上运行。安装包用户无需执行 npm install，也无需下载 Electron、浏览器或构建工具。

## 验证

开发验证命令：`npm run typecheck`、`npm test`、`npm run package:cli`。macOS 专项测试覆盖 launchd 配置与安装/停止/卸载流程、路径转义、凭据 stdin 传递和钥匙串失败处理。

当前开发机为 Linux。launchd、钥匙串和原生通知的真实系统调用仍需在 Mac 验收；连接后先执行 `uname -s; uname -m; pwd; command -v node`，确认 `Darwin`、`arm64` 和项目目录，再检查关闭终端后任务继续运行、新终端接回及断线恢复。

实现依据：[Apple launchd 指南](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)、[Apple SecurityTool 的 stdin 命令解析](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)。
