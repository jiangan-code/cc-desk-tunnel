# Linux 桌面客户端（Ubuntu 26.04 LTS x86_64）

Linux 桌面也可以作为项目执行端；Claude Code 仍在远端服务运行。不是把服务端目录当作本机项目。Windows 客户端继续使用原有 OpenSSH / PowerShell 通道。

## 构建与运行

需要普通用户、Node.js 24、npm、tar，以及图形桌面。安装发行包后不需要 Node 或 npm。

```bash
npm ci
npm run prepare:linux
npm run setup:desktop
npm run build
npm run desktop
```

`prepare:linux` 下载官方 frp 0.71.0 Linux x64，核对仓库固定 SHA256，仅把 frpc 放进忽略的 `apps/desktop/vendor/`。不会安装 sshd、修改防火墙或创建系统服务。开发时可用 `PROXY_FRPC_PATH` 指定已有 frpc。

```bash
npm run package:linux
sudo apt install ./artifacts/linux/CC-Desk-Tunnel-0.2.5-amd64.deb
```

产物包含 Electron、前端、连接桥、锁定依赖版本的纯 JS SSH 实现与 frpc。可用 `npm run package:linux -- --dir` 只生成免安装目录。只支持 Linux x64；没有宣称验证其他发行版、架构或 Windows 打包。

在程序里填写可信远端服务的 WSS 地址、证书指纹和服务凭据，再选择本机绝对项目路径。

**客户端与服务端必须一起使用本次代码（协议 11）。** 旧协议会明确拒绝连接。Linux 当前使用 deb 覆盖升级；服务端提供的 Windows exe 自升级不适用于 Linux。现有用户数据保持在 Electron 的 userData 目录（通常为 `~/.config/CC Desk Tunnel`，服从 XDG 配置），实际计划任务路径随握手传给服务端。

## 平台行为

- 路径区分大小写，保留 POSIX 文件名中的反斜杠；Windows 盘符 / UNC 路径保留原比较规则。
- SSH 仅绑定 `127.0.0.1` 的随机端口，每次连接生成独立 Ed25519 主机密钥与认证密钥；只允许当前用户名与该公钥。主机密钥在服务端固定验证。
- SSH 仅提供非交互式 Bash exec，不提供密码认证、PTY、SFTP 或端口转发。所有命令以桌面当前用户权限运行，并非目录沙箱。
- 常规断连、启动失败和退出会回收 frpc、SSH 监听、命令进程组和临时目录。强杀桌面进程可能留下命令子进程或 frpc；主动脱离进程组的命令也不能保证回收。这不等同于 Windows Job Object 的强杀保证。
- 记住凭据要求可用的 GNOME Keyring / KWallet 等安全存储。Electron `basic_text` 回退不会被用于保存凭据；不可用时界面显示错误，可以不记住凭据继续使用。
- Linux 默认关闭窗口即退出，避免 GNOME 不显示托盘导致窗口无法找回。支持托盘的桌面可以显式开启“关闭窗口时留在后台”。
- 保留 Electron sandbox、contextIsolation 和 TLS / 证书指纹验证；不要用 `--no-sandbox` 规避系统问题。

## 验证

```bash
npm run typecheck
npm test
npm run build
xvfb-run -a npx playwright test apps/desktop/test/app.spec.ts -g 'Electron loads'
```

新增测试使用真实系统 OpenSSH 验证临时密钥、错误认证、中文标准输出 / 错误、退出码、进程组清理和 Linux 路径。桌面 smoke test 使用离线模拟服务，不消费 Claude 配额。真实远端 Claude 会话仍需要用户的服务地址与凭据才能验收。

可选真实隧道回归：将经过 SHA256 校验的 frps 0.71.0 路径通过 `FRPS_TEST_PATH` 传入 `npm test`，测试会生成临时证书并验证本机 frpc → frps → SSH 的完整 TLS 通道。未设置时跳过该项。
