# im-agent-bridge

把 IM 聊天接到本机的编程助手上：支持 **飞书 / Lark** 与 **微信 iLink（ClawBot）** 两条通路，后端可以是
**Claude Code**、**Codex CLI** 或 **DeepSeek Harness（DSH）**。一条聊天消息会变成一次本机 agent 运行，
运行事件渲染回聊天，会话按聊天作用域持久化。

本仓库是 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
的 fork。包名与 CLI 仍是 `lark-channel-bridge`，上游的命令、斜杠命令与配置字段全部照旧可用；上游功能
完整保留，本 fork 是功能超集。

维护者：**罗孚传说（Rover Tang）** · <https://rovertang.com>

[English README](./README.md) · [完整使用手册](./USAGE.zh.md) · [上游原版 README](./README.upstream.zh.md)

## 本 fork 增加了什么

- **DeepSeek Harness 后端。** `dsh` 与 `claude`、`codex` 并列：用 DSH 自己的 session id 续接会话，
  provider / 模型通过生成的 `--patch` 覆盖文件传递，API Key 留在 DSH 自己的凭据存储里——bridge 不复制密钥。
- **微信 iLink 渠道。** 与飞书并列的第二条通路：私聊文本、typing 提示、引用上下文、进度消息、发送限流，
  以及温和的会话轮次提醒。
- **渠道抽象（`ChannelPort`）。** 飞书与微信是同一套端口的两个实现，以后加第三种 IM 是小范围改动。

## 两条通路，互相独立

| 维度 | 飞书 / Lark | 微信 iLink |
|---|---|---|
| 绑定方式 | 扫码创建 PersonalAgent 应用，或已有 App ID + Secret | 终端扫码登录 ClawBot 账号 |
| 传输 | WebSocket | HTTP 长轮询 |
| 消息形态 | 卡片、markdown、流式、撤回、reaction | 纯文本、append-only、typing |
| 聊天命令 | 完整命令集：`/new`、`/cd`、`/ws`、`/status`、`/config`、`/invite`、`/stop` 等 | `/help`、`/new`、`/reset`、`/stop`、`/status` |
| 群聊与文档 | 群聊、话题群、云文档评论 | 仅私聊、单账号 |
| 访问控制 | 用户 / 群 / 管理员 | `weixin.ownerId` + `weixin.allowedUsers` |
| 后台服务 | `start/stop/restart/status/unregister`；支持 `--web-ui` 控制面 | 同样的命令，不支持 `--web-ui` |

一个 profile 只属于一条通路、一种 agent。**两条通路的 session 不互通**：`/new`、`/stop` 只作用于各自
渠道。两个 profile 可以指向同一个 workspace（文件共享），但不建议这样做。

## 环境要求

- Node.js **>= 20.12.0**，pnpm 10。
- 至少安装并登录一个 agent：`claude`、`codex` 或 `dsh`（DSH 需 `dsh --version` 能跑通）。
- 飞书 / Lark：一个 PersonalAgent 应用（扫码向导可以创建并绑定）。
- 微信：微信客户端 + ClawBot / iLink 能力；登录二维码需要 TTY。

## 安装

本 fork 未发布到 npm，需要从源码构建：

```bash
git clone https://github.com/rovertang/im-agent-bridge.git
cd im-agent-bridge
pnpm install
pnpm build
npm link        # 可选；不做全局安装时用：node bin/lark-channel-bridge.mjs <cmd>
```

`start` 会记录 CLI 路径，所以使用后台服务命令前请先做全局安装。

## 快速开始

### 飞书 / Lark

```bash
lark-channel-bridge profile create feishu --agent dsh   # 扫码向导：创建并绑定应用
lark-channel-bridge run --profile feishu                # 前台运行，确认能正常回复
lark-channel-bridge start --profile feishu              # 安装为后台服务
```

已有应用时加 `--app-id cli_xxxxxxxxxxxx` 跳过应用创建（Lark 国际版再加 `--tenant lark`）。要使用其他后端
就改成 `--agent claude` 或 `--agent codex`。

### 微信 iLink

```bash
lark-channel-bridge profile create wx --channel weixin --agent dsh
lark-channel-bridge weixin login --profile wx           # 扫二维码，必要时输入手机上的数字验证码
lark-channel-bridge run --profile wx                    # 前台运行，打印"微信渠道已上线"
lark-channel-bridge start --profile wx                  # 安装为后台服务
```

### 后台服务与多 profile

```bash
lark-channel-bridge start|stop|restart|status|unregister [--profile <name>]
lark-channel-bridge profile list|use|remove|export <name>
```

服务按 profile 隔离：macOS launchd、Linux systemd 用户单元、Windows 计划任务。可以同时跑多个 profile
（例如一个飞书、一个微信），每个 profile 有独立的凭据、会话、工作目录和日志。`profile list` 会显示每个
profile 的通路、agent 和运行中的 pid。

## 文档

- **[USAGE.zh.md](./USAGE.zh.md)** — 完整使用手册：架构与两条通路、绑定与初始化、日常命令表、默认
  workspace、权限与安全、媒体/引用/进度能力、排错、已知限制与数据目录。
- [README.upstream.md](./README.upstream.md) / [README.upstream.zh.md](./README.upstream.zh.md) —
  上游原版文档，原样保留，用于查阅继承来的功能。
- [飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)
- [docs/GIT_COMMIT_RULES.md](./docs/GIT_COMMIT_RULES.md) — 提交/推送规则与密钥扫描。

## 开发

```bash
pnpm test            # 单元 + 集成 + 进程级测试
pnpm typecheck
pnpm build
pnpm hooks:install   # 安装 git-guard 提交/推送钩子（每个克隆一次）
pnpm ci:local        # 推送前完整检查：规则 + 测试 + 类型检查 + 构建
```

## 维护者与许可

本 fork 由 **罗孚传说（Rover Tang）** 维护 · <https://rovertang.com> · 公众号 **罗孚传说**。
与 DSH 后端或微信渠道相关的问题和 PR，欢迎提到
[本 fork](https://github.com/rovertang/im-agent-bridge/issues)；bridge 本身的问题请提到
[上游项目](https://github.com/zarazhangrui/lark-coding-agent-bridge/issues)。

[MIT](./LICENSE)，继承自上游项目。
