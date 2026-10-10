# 多个 Claude 账号

服务端可以登录多个 Claude 账号，并选定其中一个作为“当前账号”：之后新开的 agent 和图形界面的运行都用它，已经在运行的不受影响。对话记录各账号共用，所以一个账号的额度用完时，换到另一个账号后可以接着同一段对话。

做法是 Claude Code 官方支持的 `CLAUDE_CONFIG_DIR`（见 [Authentication](https://code.claude.com/docs/en/authentication)）：每个账号一个独立的 CLI 配置目录，登录凭据、设置和 CLI 状态各自保存。服务端不读取也不复制凭据，登录和退出都走官方的 `claude auth`。

条款同样由你自己确认，见首页的[账号须知](../README.md#账号须知)。

## 目录

| 位置（容器内） | 内容 |
| --- | --- |
| `~/.claude/` | 默认账号 `default`，就是 CLI 自己的默认目录 |
| `~/.claude-accounts/<名字>/` | 其他账号，一个账号一个目录，作为该账号进程的 `CLAUDE_CONFIG_DIR` |
| `~/.claude-accounts/<名字>/projects` | 软链接到 `~/.claude/projects`，所以对话是共用的 |
| `<数据目录>/state/account.json` | 当前账号的名字 |

容器里 `HOME=/data/home`，这些目录都在数据目录内：重建容器不会丢失，`deploy/manage.sh backup` 也会一起备份。

账号名只能用小写字母、数字、`-` 和 `_`，最长 32 个字符，`default` 保留给默认账号。

## 在 ccdt 里使用

在 agent 列表里按 `a` 打开账号列表，它显示每个账号的登录邮箱和订阅类型，列表顶部标题栏显示当前账号。

| 按键 | 作用 |
| --- | --- |
| `j` / `k` 或方向键 | 移动 |
| `Enter` | 把选中的账号设为当前账号 |
| `n` | 新建账号并设为当前账号 |
| `Esc` / `a` | 回到 agent 列表 |

**新建并登录：**

1. 在账号列表里按 `n`，输入名字（例如 `work`）。
2. 回到列表，进入任意一个 agent（或用 `n` 新建）。新账号没有登录，Claude Code 会先走首次引导：选主题，再选 Claude 订阅登录。
3. 终端里会显示一个授权链接。在本地浏览器里打开它，**确认浏览器当前登录的是要添加的那个 Claude 账号**（不确定就用无痕窗口），授权后把页面上的代码粘回终端。
4. 新账号第一次进入每个会话目录时，Claude Code 会再询问一次是否信任这个目录，确认即可。

**换号接着对话：** 在账号列表里切到另一个账号，回到列表，选中原来的 agent 按 `d` 结束它（对话保留），再按 `Enter` 进入。它会以新账号启动，并用 `--continue` 接着刚才那段对话。

运行中的 agent 如果用的不是当前账号，列表里会在名字后面标出 `@账号名`。

## 不经 ccdt 使用

在服务端容器里直接运行 CLI 时，用环境变量指定账号即可：

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/work claude            # 以 work 账号启动
CLAUDE_CONFIG_DIR=~/.claude-accounts/work claude auth status # 查看它的登录状态
CLAUDE_CONFIG_DIR=~/.claude-accounts/work claude auth login  # 打印授权链接，把浏览器给出的代码粘回来
```

不通过 `n` 新建、自己手工建的账号目录，服务端同样会识别（下次刷新账号列表时出现）。要共用对话，需要自己补上 `projects` 软链接：

```bash
mkdir -p ~/.claude-accounts/work && chmod 700 ~/.claude-accounts ~/.claude-accounts/work
ln -s ~/.claude/projects ~/.claude-accounts/work/projects
cp ~/.claude/settings.json ~/.claude-accounts/work/   # 可选：沿用默认账号的设置
```

## 注意

- **设置各自独立。** 新建账号时复制一份默认账号的 `settings.json`，之后两边互不同步。图形界面的“原生设置”、终端里的 `/config` 改的都是当前账号的设置。
- **登录与退出只作用于当前账号。** 桌面客户端的账号页照常可用，管理的是当前账号。有 agent 或运行正在使用某个账号时，不能对它登录或退出；其他账号不受影响。
- **用量统计不分账号。** 账号页的统计来自所有 CLI 进程，不按账号拆开；各账号的额度要切到该账号后查看。
- **删除账号：** 先结束所有用这个账号的 agent，再删除它的目录 `~/.claude-accounts/<名字>`。`projects` 只是软链接，删除目录不会删除共用的对话；不要对软链接指向的目录使用 `rm -r`。如果删的是当前账号，服务端会回到 `default`。
- **自己建的目录里，`projects` 如果是一个真实目录而不是软链接，** 那个账号的对话就不与其他账号共用，服务端也找不到这些对话来续接、改名或删除。

## 实现

| 部分 | 位置 |
| --- | --- |
| 账号目录、当前账号、`CLAUDE_CONFIG_DIR` 环境 | `apps/server/src/native-profiles.ts` |
| 运行、终端、状态读取、登录 / 退出、设置使用对应账号 | `apps/server/src/server.ts`、`native-account.ts` |
| 协议：`account.use` / `account.add`，`account.state` 的 `profile` / `profiles`，终端的 `profile` | `packages/protocol/src/index.ts` |
| ccdt 账号列表 | `apps/cli/src/deck.mjs` |

协议只做了增量扩展，没有升协议版本：旧客户端照常连接，看到的是当前账号；新 ccdt 连旧服务端时，按 `a` 会提示服务端不支持多账号。服务端发给 CLI 进程的环境只多一个 `CLAUDE_CONFIG_DIR`；服务端自己用 Agent SDK 查找、续接、改名、删除对话时读的是默认目录的 `projects`，所以其他账号目录里必须是指向它的软链接。
