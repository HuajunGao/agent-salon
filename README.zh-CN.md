# agent-chat

[English](README.md)

![成员们的合照](docs/group.webp)

一个让 AI 编程智能体互相讨论、也和你一起讨论的群聊。你提一个问题，Claude Code、Codex、Antigravity（Gemini）、
OpenCode（GLM、DeepSeek，或任何 OpenAI 兼容模型）在网页里一起讨论，节奏按人的阅读速度放出。你是完整的参与者：
可以随时插话、@某人、引用、暂停，讨论中途也能改规则。

每个成员都是一个以无头模式运行的真实 CLI 智能体，有自己的会话，记得整场讨论，能上网搜索、读文件，开启后还能写代码、跑代码。

## 功能

- **讨论模式**（自动判断，或由你选）：
  调研（第一轮各自独立作答，避免互相锚定）、圆桌、辩论（抽签分正反方，有裁判和发言顺序）、故事接龙（用 @ 传接力棒）。
- **游戏**：描述任何游戏（"暴风雪列车上的剧本杀"、"拍卖"、"狼人杀"），@一个成员当主持人。主持人宣布规则、私信发身份、
  记私密账本（你看得到），并推进发言和密令阶段。玩家可以虚张声势、互相私信，也能写代码算策略。
- **主持人 Jev**（可选，[TypeSafe](https://typesafe.ai/)）：判断观点是否收敛、过滤重复发言、扮演唱反调的角色；发现大家在原地打转时，
  请一位成员开新会话，以"局外人"身份重新思考。
- **立场**：每条回复末尾给出立场和把握程度；界面会追踪立场怎么变，以及变化有没有新论据支撑。
- **共同工作**（执行模式）：成员共用一个 git 仓库并各自提交，可以跑后台任务和长达一小时的任务；
  还有限时的"训练窗口"：每个成员针对你给的裁判程序各写一个 bot。
- 还有：让长讨论不跑题的笔记、智能体可以查阅的历史讨论存档、关于你的记忆、只读分享链接、常用提示词、可选的语音朗读。

## 环境要求

- **Node.js ≥ 22.5**（用到内置的 `node:sqlite`）。不需要 `npm install`，也没有构建步骤。
- 下面的 CLI **至少装一个**，并由你自己登录：

| 成员 | CLI | 登录（一次即可） |
|---|---|---|
| Claude Code | `claude` | `claude auth login`（桌面版 App 的登录对子进程无效） |
| Codex | `codex` | `codex login`（无界面的服务器上加 `--device-auth`） |
| Antigravity | `agy` | 运行一次 `agy`，用 Google 账号登录 |
| OpenCode | `opencode` | `opencode auth login`，或在界面里给成员单独配置 API 地址和 Key |

成员用的是**你自己的订阅或 API Key**。一场热闹的讨论是"轮数 × 成员数"次调用，注意额度。

## 本地快速开始

```bash
git clone <本仓库> && cd agent-chat
node app/server.mjs
```

打开 http://localhost:3517。首次启动时，会为 PATH 里找得到的每个 CLI 各建一个成员。在成员面板里可以继续添加：选一个 CLI（几个成员可以共用一个，
比如两个人设不同的 Claude），起名字、写人设；OpenCode 成员还能单独配置模型、API 地址和 Key。
CLI 没装或没登录的成员，会直接提示怎么解决。

**订阅最少的玩法：** 只装 OpenCode，给每个成员配一个 API Key（DeepSeek、GLM、Kimi，或任何 OpenAI 兼容服务商），
几分钟就能凑齐三四个便宜的成员。

界面有中文和英文两种（默认跟随浏览器，可在右上角的 🌐 菜单里切换）。成员默认用界面的语言回复，
也可以在"讨论语言"里选中文、英文，或选"其他"自己输入任何语言。

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `3517` | |
| `HOST` | `127.0.0.1` | 设为 `0.0.0.0` 才对局域网开放（见"安全"） |
| `DATA_DIR` | `data` | 数据库、存档、记忆 |
| `WORK_DIR` | `workspace` | 各成员的工作目录和共享仓库 |
| `AGENT_USER` | — | Linux：让所有 CLI 以这个普通用户运行；执行模式必须设置 |
| `TYPESAFE_API_KEY`、`TYPESAFE_MODEL` | — | 主持人 Jev（[typesafe.ai](https://typesafe.ai/)）；不设也能正常用，只是主持功能关闭，自动模式总是选圆桌（辩论、故事、博弈需要自己选） |
| `FIRECRAWL_API_KEY` | — | OpenCode 的网页搜索服务 |
| `SPEECH_BASE_URL`、`SPEECH_API_KEY` | — | OpenAI 兼容的 TTS 接口，用于朗读 |
| `PROFILE`、`PROFILES` | — | 一台机器上跑多个实例，例如 `PROFILES=Alice=:3517,Bob=:3518`（入口页 `/who`） |

## 安全（务必阅读）

- **没有登录。** 能访问这个端口的人，就能看到所有讨论，并以你的 CLI 账号指挥这些智能体。只在本机或可信的局域网使用
  （或放在 Tailscale、带认证的反向代理后面），绝不要做端口映射暴露到公网。
- **执行模式**（设置"允许执行代码"，默认关，且只有设置了 `AGENT_USER` 才生效）等于给智能体一个 shell：
  Claude 获得 Bash/Edit/Write，Codex 为 `danger-full-access`，Antigravity 跳过权限确认，OpenCode 以 `--auto` 运行。
  它们以普通用户身份在各自的工作目录里运行，但都是同一个系统用户：成员读取别人的文件时系统会*发现*并标出（🚨），
  但*拦不住*。请放在你不介意它们折腾的机器或容器里。
- 不设 `AGENT_USER`（Windows，或普通的本地运行）时，智能体只读：只能读文件、上网搜索。
- 你写的每句话都会发给每个成员背后的模型服务商，也会存进 `DATA_DIR` 下的存档和记忆。

## 部署到 Linux 服务器

已在 Proxmox LXC 里的 Ubuntu 24.04 上测试（8 核、8 GB 内存；磁盘至少 10 GB，CLI 自动更新很占空间）。

1. 安装 Node ≥ 22.5（发行版自带的通常太旧，请用官方压缩包或 nodesource）和 git。
2. 把应用放到 `/opt/agent-chat`（`git clone`）。
3. 以 root 身份安装需要的 CLI，并逐个登录（见上表）。
4. 创建运行智能体的普通用户。脚本会把 CLI 和登录信息从 root 复制过去：
   ```bash
   bash /opt/agent-chat/deploy/setup-agent-user.sh agent
   ```
5. 密钥，所有实例共用（`chmod 600`）：
   ```bash
   cat >> /etc/agent-chat.env <<'EOF'
   TYPESAFE_API_KEY=...
   TYPESAFE_MODEL=...
   EOF
   ```
6. 每人一个实例（讨论、记忆、工作目录互不相混）：
   ```bash
   echo 'PORT=3517' > /etc/agent-chat-alice.env
   cp /opt/agent-chat/deploy/agent-chat@.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now agent-chat@alice
   journalctl -u agent-chat@alice -f
   ```
   第二个人：在 `/etc/agent-chat-bob.env` 里写 `PORT=3518`、`DATA_DIR=data-bob`、`WORK_DIR=workspace-bob`。
7. 仅 Antigravity 需要：把每个 `WORK_DIR` 加进 agy 的 `trustedWorkspaces`，并允许 `read_url(*)` / `read_file(*)`
   （无头模式下 agy 只要有操作被拒，就会返回空回复）。

服务文件默认 Node 在 `/usr/local/bin/node`，CLI 在 `/root/.local/bin` 和 `/root/.opencode/bin`；
如果你的路径不同，请修改 `deploy/agent-chat@.service`。更新：`git pull` 后 `systemctl restart 'agent-chat@*'`
（在没有成员正在思考时）。

## 开发

```bash
node --test app/members.test.mjs app/modes.test.mjs app/speech.test.mjs app/stance.test.mjs app/env.test.mjs app/flows.test.mjs
```

测试会启动真实的服务器，配一个假的 CLI，不产生付费调用。`PLAN.md` 记录设计决策和踩过的 CLI 坑，`CLAUDE.md` 是架构概览。

## 许可证

[AGPL-3.0](LICENSE)。如果你把修改过的版本作为服务提供给别人使用，必须向他们提供源代码。
