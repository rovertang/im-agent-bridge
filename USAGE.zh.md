# lark-channel-bridge（DSH fork）使用文档

> 面向本仓库的维护者和日常使用者：既讲清两条通路（飞书 / 微信 iLink）的架构，也能照着完成绑定与日常使用。
> 命令名、配置键、路径与默认值取自当前代码（`package.json` 版本 `0.7.1`）；若有出入，以代码为准。
> 上游功能的完整说明见 [`README.zh.md`](./README.zh.md)；提交规范见
> [`docs/GIT_COMMIT_RULES.md`](./docs/GIT_COMMIT_RULES.md)。文中 token / 账号 / userId / base URL 一律为占位符。

## 快速开始

```bash
git clone https://github.com/rovertang/lark-coding-agent-bridge-dsh.git && cd lark-coding-agent-bridge-dsh
pnpm install && pnpm build && npm link        # 或始终用 node bin/lark-channel-bridge.mjs

# 飞书：扫码建应用（或加 --app-id），然后前台跑起来
lark-channel-bridge profile create feishu --agent dsh && lark-channel-bridge run --profile feishu

# 微信：创建 profile → 扫码登录 → 前台跑起来
lark-channel-bridge profile create wx --channel weixin --agent dsh
lark-channel-bridge weixin login --profile wx && lark-channel-bridge run --profile wx
```

## 1. 概览

### 1.1 bridge 是什么

`lark-channel-bridge` 把 IM 聊天接上本机的编程 agent：聊天里的消息被转成一次本机 agent 运行，运行事件被渲染回
聊天消息，会话按作用域持久化，从而支持多轮续接、`/new` 重置、工作目录切换。本 fork 在上游基础上：

1. 增加 **DeepSeek Harness（`dsh`）** 作为第三种 agent，与 `claude`、`codex` 并列；
2. 增加 **微信 iLink（ClawBot）** 作为第二条渠道，与飞书通路并列。

一个 profile 只属于一条通路、一种 agent；同一个 `config.json` 可以管理多个 profile。

### 1.2 两条通路

| 维度 | 飞书 / Lark | 微信 iLink |
|---|---|---|
| 配置 | `channel.kind` 缺省（即 `lark`） | `channel.kind: "weixin"` |
| 身份 | 飞书 PersonalAgent 应用（`accounts.app`） | 微信 ClawBot 账号（`ilink_bot_id`） |
| 凭据 | `secrets.enc` / 加密 keystore / `${ENV}` | `<profileDir>/weixin/accounts/<safeId>.json`（0600） |
| 传输 | WebSocket（`@larksuite/channel`） | HTTP 长轮询（`ilink/bot/getupdates`） |
| 消息形态 | 卡片 / markdown / 文本、流式、撤回、reaction | 纯文本、append-only、typing |
| 能力 | 附件、引用、话题、文档评论、会议、lark-cli、交互卡片 | 私聊文本、引用上下文、typing、进度提示 |
| 启动 | `run/start --profile X`，支持 `--web-ui` 控制面 | `run/start --profile X`，**不支持** `--web-ui` |
| 聊天命令 | 完整命令集（含卡片类） | `/help` `/new` `/reset` `/stop` `/status` |

### 1.3 共同点与差异

共同点：以 profile 为隔离单位（独立的 agent 配置、会话、工作目录、日志、运行锁）；复用
`startRunFlow → RunExecutor → AgentAdapter.run` 与 session / workspace / 访问控制 / 权限策略；都能用 `run`
（前台）或 `start`（launchd / systemd / schtasks）运行；默认工作目录、权限模式、DSH provider 写法一致。

差异：飞书有交互卡片、流式输出和停止按钮；微信只能发不可编辑的文本，**没有**卡片、按钮、`/config` 表单、
流式草稿，也没有 `/cd`、`/ws`，工作目录固定为 `workspaces.default`；微信的访问控制是 profile 内的
`weixin.ownerId` + `weixin.allowedUsers`（fail-closed），没有 `/invite`；微信不走 supervisor/控制面。

## 2. 架构与实现

### 2.1 进程与 profile 模型

```text
~/.lark-channel/{config.json, active-profile, profiles/<profile>/, registry/}

CLI → resolveProfileRuntime()   # 解析 profile、迁移旧配置、补默认 workspace
    → 飞书：Supervisor → startChannel() → LarkChannel（WS）
    → 微信：startWeixinProfile() → startWeixinTransport() → WeixinRunner
```

运行形态：

| 形态 | 命令 | 说明 |
|---|---|---|
| 单 profile 前台 | `run [--profile X]` | 终端前台，Ctrl-C 退出 |
| 单 profile 守护 | `start/stop/restart/status/unregister [--profile X]` | 交给操作系统托管 |
| 机器级控制面 | `run --web-ui` / `start --web-ui` | 一个进程托管所有 profile + Web 控制台；**只支持飞书 profile** |

并发保护：profile 锁（同一 profile 不能起两份，冲突时前台会询问是否停掉占用者）；app/渠道锁
（飞书按 `app_id`、微信按 `weixin:<ilink_bot_id>`，同一身份不能被两个 profile 同时使用）；host 锁
（仅 `--web-ui`，保证一台机器一个 supervisor）。

### 2.2 飞书通路

- **连接**：`createLarkChannel()` 建立 WebSocket，握手完成才算上线；`keepalive` 负责 ping、重连与
  强制重连（`/reconnect`）。
- **入站**：`channel.on({ message, cardAction, comment, … })` → 计算 scope（私聊/群 `chat_id`、话题群
  `chat_id:thread_id`、评论 `doc:` 前缀）→ 访问控制 → 命令分发 → 未命中则进 600ms 静默合并队列，
  合并后批量交给一次 run。
- **出站**：同一条 `RunState` 有四条渲染路径——交互卡片（CardKit 2.0，带停止按钮）、markdown 卡片、
  纯文本、COT 过程气泡。停止按钮、`/config` 表单、`/invite` 选择器都依赖卡片能力。
- **lark-cli**：每个 profile 有独立配置目录，agent 进程通过 `LARKSUITE_CLI_CONFIG_DIR` 指向它；身份策略
  默认 `bot-only`，可在 `/config` 切到 `user-default`。文档评论、视频会议、附件也只在飞书侧实现。

### 2.3 微信通路（iLink）

协议层 vendor 自官方 `openclaw-weixin`（MIT，v2.4.10），改写为无 openclaw 依赖，位于 `src/channel/weixin/`。

**生命周期与入站**

```text
startWeixinTransport()
  → notifyStart()        # ilink/bot/msg/notifystart；未上线前用户消息不会投递
  → 循环 getUpdates()    # 长轮询（约 35s）
      → 持久化 get_updates_buf 游标 → <profileDir>/weixin/<safeId>.sync.json
      → message_id 去重 → 只处理 message_type=user → 交给 runner
  → stop(): abort 长轮询 → 等循环退出 → 落盘游标 → notifyStop()
```

- 连续失败 3 次进入 30s 退避，单次失败 2s 重试；错误只记日志，不退出循环。
- `ret/errcode = -14` 视为 **token 失效**：状态变 `token-expired`，循环终止，日志出现 `transport-stopped`，
  只能重新 `weixin login`。
- 每条入站消息带一个 `context_token`，回复时原样回传，用于会话关联。

**出站（append-only）**

- 没有"编辑 / 撤回 / reaction"接口，`message_state` 只写 `FINISH`；能力位是 `streaming: 'none'`、
  `recall: false`，调用方必须自行降级。
- 每条消息使用**新的 `client_id`**（服务端幂等键）；超过 4000 字符按行切分；同一会话两条出站至少间隔
  300ms（`WEIXIN_MIN_SEND_INTERVAL_MS`），防止服务端限流丢消息。
- 目前只支持文本；`card` / `image` / `file` payload 抛 `ChannelUnsupportedError`（媒体回传未实现）。

**typing**：用 `ilink/bot/getconfig` 取 per-user `typing_ticket`，再调 `sendtyping`；心跳 4s，结束发取消。
typing 只是观感信号，取不到 ticket 或发送失败只记 warning，不影响回复。

**引用缓存**：微信的引用回复只给 `ref_msg.message_item.msg_id`，不带原文。bridge 按"账号 + 对端"维护
500 条环形缓存（`<profileDir>/weixin/quotes.json`，0600），用户消息与 bot 回复都记录；运行时解析成
`<quoted_message id="…" from="user|bot">…</quoted_message>` 拼在消息前。缓存未命中时退回客户端内联文本，
再没有就写"内容不可用"。

**轮次计数与软提示**：每条被受理的用户消息计数 +1，按"账号|对端"持久化到
`<profileDir>/weixin/turns.json`，`/new`、`/reset` 清零。阈值是常量 `WEIXIN_MAX_SESSION_TURNS = 50`：

- 达到 25 轮（`ceil(50/2)`）时在回复末尾**一次性**追加"当前会话较长，如需重新开始可发送 /new"；
- 达到 50 轮后每条回复都追加"消息交互次数较多，建议使用 /new 命令重新开启新会话"。

这只是 UX 提示，**从不阻断**消息；实测服务端没有硬性轮次上限。

**进程与作用域**：会话 scope 固定为 `wx:dm:<peer>`（`peer` 是对方 `ilink_user_id`），与飞书的 `chat_id`
命名空间区分；`startWeixinProfile()` 依次取 profile 锁与渠道锁、写注册表（`tenant/channel=weixin`）、
启动传输、构造 runner，停止时依次停 runner → 停 transport → 注销 → 释放锁。一个 profile 只用
`weixin.accounts[0]`（多账号未支持）；只处理私聊。

### 2.4 DSH 后端如何被调用

一次运行就是一个 `dsh` 进程：

```bash
dsh --profile headless \
    --patch <profileDir>/dsh/provider.patch.yml \
    --patch <profileDir>/dsh/model-<hash>.patch.yml \
    --json \
    [--session-id session-<uuid>] -
```

- **工作目录**不作为参数：bridge 直接以本次运行的 cwd 启动子进程，DSH 由此推导会话工作区与沙箱授权根。
  这也是 `/cd`、`/ws` 能原样生效的原因。
- **权限模式**走 `DSH_PERMISSION_MODE`（`read-only` / `workspace-write` / `danger-full-access`），与 bridge
  词汇一致，是经校验的直通。
- **任务本体**从 stdin 传入，避免多行长 prompt 出现在命令行上（Windows 会截断命令行）。
- 两份覆盖文件写在 `<profileDir>/dsh/`（内容不变不重写，不改磁盘上的 DSH profile）：
  `provider.patch.yml` 声明 provider 与模型列表，`model-<hash>.patch.yml` 固定 `agent-default-model`。
  **后者不可省略**，否则会落到 DSH 内置路由并报 `MISSING_CREDENTIAL`。
- **会话续接**：DSH 在 stdout 输出 `{"type":"session","sessionId":"session-…"}`，bridge 记入
  `sessions.json`，下一轮用 `--session-id` 回传；DSH 被当作"session id 类" agent。
- **模型选择**：飞书可在 `/config` 里选；微信没有 `/config`，只能改 `preferences.model`
  （或依赖 `provider.defaultModel`），重启生效。
- **`/stop`**：其他平台发 `SIGTERM`；Windows 上 `dsh` 通常是 `.cmd` 包装脚本，bridge 用
  `taskkill /PID <pid> /T /F` 终止整棵进程树，宽限期后仍存活则回退 `SIGKILL`。

### 2.5 两条通路互相独立（重要）

1. **session 不互通。** 会话状态按 profile 存放，scope 也做了命名空间隔离（飞书 `chat_id` /
   `chat_id:thread_id` / `doc:`，微信 `wx:dm:<peer>`）。即使两个 profile 指向同一目录，也不会共享会话，
   更不会"接着聊"。
2. **`/new`、`/stop` 只作用于各自渠道。** 微信发 `/new` 只清微信那个私聊的会话；飞书会话与正在跑的任务
   不受影响。`/stop` 同理，只停本渠道当前那次运行。
3. **workspace 可以指向同一目录（文件共享），但不建议。** 两个 agent 会看到同一批文件，也可能同时写同一
   文件；DSH 的会话/沙箱根按 cwd 推导，cwd 一变会话即失效。共享只适合只读资料或人工协调的场景。
4. **两个 profile 可以同时运行。** 典型组合：`feishu` + `wx`，或两个不同 PersonalAgent 应用。限制：同一
   profile 不能起两份、同一微信账号不能被两个 profile 同时使用、同一飞书应用不能同时被两个 profile 连接。
5. **`profile use` 只是 CLI 默认值。** 它影响不带 `--profile` 的命令（`run`、`start`、`weixin login`、
   `profile list` 的高亮），不影响已在运行的守护进程。

## 3. 环境要求与安装

| 项目 | 要求 |
|---|---|
| Node.js | `>= 20.12.0`（`engines`） |
| 包管理器 | pnpm 10（`packageManager: pnpm@10.33.0`） |
| DSH | 可执行的 `dsh`，已登录要用的 provider；`dsh --version` 能跑通 |
| 飞书 | PersonalAgent 应用（可扫码创建），或已有 `App ID` + `App Secret` |
| 微信 | 微信客户端 + 可扫码登录的 ClawBot / iLink 能力；二维码需要 TTY |
| 服务托管 | macOS launchd、Linux systemd 用户单元、Windows 计划任务 |

```bash
git clone https://github.com/rovertang/lark-coding-agent-bridge-dsh.git
cd lark-coding-agent-bridge-dsh
pnpm install
pnpm build
npm link        # 可选；不做全局安装时用 node bin/lark-channel-bridge.mjs <cmd>
```

- 本 fork 未发布到 npm，必须从源码构建；`bin/lark-channel-bridge.mjs` 加载 `dist/cli.js`，构建失败就无法
  运行 CLI。
- `run` 用 `npx` 临时运行可以，但 `start` 会记录 CLI 路径，**必须**用全局安装后的稳定路径。
- 自检：`pnpm test`、`pnpm typecheck`、`pnpm build`。

## 4. 绑定与初始化

### 4.1 飞书通路

```bash
# 方式 A：扫码创建应用（推荐首次使用；目录必须已存在）
lark-channel-bridge profile create feishu --agent dsh
lark-channel-bridge profile create feishu --agent dsh --workspace ~/work/my-project

# 方式 B：已有应用（--tenant lark 用于 Lark 国际版，默认 feishu）
lark-channel-bridge profile create feishu --agent dsh --app-id cli_xxxxxxxxxxxx
# 交互式输入 App Secret；或在可信环境用 --app-secret 传入
```

方式 A 在 TTY 中渲染二维码 → 用飞书 / Lark 扫码 → 选择或创建 PersonalAgent 应用 → 写入
`~/.lark-channel/config.json`。方式 B 会校验凭据并打印 bot 名称；非交互环境必须传 `--app-id`，密码仍需
交互输入或显式传参。

首次运行与 lark-cli 预检：

```bash
lark-channel-bridge run --profile feishu    # 前台调试
lark-channel-bridge start --profile feishu  # 确认可用后安装为后台服务
```

- 首次 `run/start` 会做 lark-cli 预检：未安装时在 TTY 里提示并自动安装、自动 bind；非 TTY 只打印手动安装
  提示后继续启动。要跳过：`--skip-check-lark-cli`。
- 预检还会检查 agent 是否可用（DSH 冷启动要跑 `dsh --version`，超时放宽到 20s）。
- 新建 profile 的 `dsh.provider` 只是占位示例（`oneapi.example.com` 不是真实网关）：必须改成自己的
  OpenAI 兼容网关，并确认 `apiKeyEnv` 指向的凭据存在于 DSH 的凭据存储（`$DSH_HOME/.credentials.yaml`）。
  密钥不要写进 bridge 配置。

### 4.2 微信通路

**第 1 步：创建 weixin profile**

```bash
lark-channel-bridge profile create wx --channel weixin --agent dsh
lark-channel-bridge profile create wx --channel weixin --agent dsh --workspace ~/work/demo
```

- `--channel weixin` 跳过飞书扫码/凭据向导，写入 `channel: { kind: "weixin" }` 与 `weixin: { accounts: [] }`，
  **不需要**任何飞书凭据。
- `--agent` 可选 `claude` / `codex` / `dsh`；不传时按 profile 名推断（名为 `dsh`/`codex` 用对应 agent），
  否则默认 `claude`。**微信 + DSH 请显式写 `--agent dsh`。**
- 创建时就会解析 `dsh`（`PATH` 或 `LARK_CHANNEL_DSH_BIN`），找不到直接失败。
- 若根配置还是旧版单 profile 飞书格式，会提示先跑一次 `run` 完成迁移。

**第 2 步：扫码登录**

```bash
lark-channel-bridge weixin login --profile wx
```

- 在 TTY 中运行：终端打印 ASCII 二维码，同时给出可复制的链接（二维码显示失败时用手机打开）。
- 手机扫码后可能要求输入**手机微信上显示的数字验证码**，按提示输入回车即可。整段流程总超时 480s，
  二维码过期会自动刷新（最多 3 次）；同一个错误验证码重复提交会直接中止。需要验证码时非 TTY 会失败。
- 凭证写入 `<profileDir>/weixin/`：`index.json`（账号索引）与 `accounts/<safeId>.json`
  （`ilink_bot_id`、`bot_token`、`baseUrl`、`ilink_user_id`，0600）。**token 不写进 `config.json`**，
  配置里只记录 `weixin.accounts: [{ id, baseUrl }]` 和扫码者绑定的 `ownerId`。
- 已绑定的账号再次扫码会得到 `binded_redirect`：服务端不下发新凭证，CLI 报错退出，但**本地既有凭证仍有效**，
  直接 `run` 即可（见 §6.2）。登录完成后需（重新）启动 bridge 才生效。

**第 3 步：运行**

```bash
lark-channel-bridge run --profile wx        # 前台，会打印"微信渠道已上线"
lark-channel-bridge start --profile wx      # 后台服务（launchd / systemd / schtasks）
lark-channel-bridge status --profile wx
```

`run/start` 会预检本地微信凭证与 agent；没登录过会直接报：

```text
profile「wx」还没有登录微信账号：请先运行 `lark-channel-bridge weixin login --profile wx`。
```

调试用的一次性发送（不需要 bridge 在跑；多账号用 `--account`，默认 `weixin.accounts[0]`）：

```bash
lark-channel-bridge weixin send --profile wx --to <ilink_user_id> --text "hello"
```

### 4.3 profile 切换与管理

```bash
lark-channel-bridge profile list                       # ACTIVE / PROFILE / CHANNEL / AGENT / STATUS
lark-channel-bridge profile use wx                     # 切换默认 profile
lark-channel-bridge profile remove old --purge --yes   # 默认归档；--purge --yes 彻底删除
lark-channel-bridge profile export wx --output ./wx-profile.json
```

- `profile list` 的 `CHANNEL` 列显示 `lark` 或 `weixin`，`STATUS` 显示运行中的 pid/agent。
- `profile remove` 会先检查运行锁：先 `stop`/`unregister` 再删。
- **备份提醒**：`profile export` 只导出 profile 配置，**不含**微信 bot token（在 `<profileDir>/weixin/`）。
  迁移整机时要一起复制该目录并保持 0600。
- 推荐用不同 profile 名（如 `feishu` 与 `wx`）分别承载两条通路；不要试图在一个 profile 里同时接飞书和微信
  ——`channel.kind` 只能取一个值。

## 5. 日常使用

### 5.1 飞书命令表

私聊不需要 `@`；群聊和话题群默认需要 `@bot`（`@all` 被忽略）。以下命令只在飞书通路可用，微信没有对应实现。

| 命令 | 作用 |
|---|---|
| `/new`、`/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` / `/ws save <name>` / `/ws use <name>` / `/ws remove <name>` | 命名工作目录管理 |
| `/resume` | 延续同一 agent、同一工作目录、同一权限模式下兼容的历史 |
| `/status` | 显示 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、模型、访问设置和 lark-cli 身份策略（卡片表单） |
| `/invite user @name` / `/invite admin @name` / `/invite group` / `/invite all group` | 访问控制 |
| `/remove user @name` / `/remove admin @name` / `/remove group` | 移除访问条目 |
| `/stop` | 停止当前运行（卡片上的停止按钮等价） |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的空闲看门狗 |
| `/ps` / `/exit <id\|#>` | 列出本机 bridge 进程 / 停止某个进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [description]` | 运行低敏感度诊断 |
| `/help` | 帮助卡片 |

补充：卡片类交互（`/config` 表单、`/invite` 选择器、停止按钮、`/help` 卡片）**仅飞书可用**，纯文本渠道会被
能力门控拒绝（"该命令仅在飞书渠道可用。"）；代码里还有 `/account`、`/doc`、`/meeting` 等命令，行为以
`/help` 卡片和源码为准；`/resume` 无法浏览 DSH 原生历史（`supportsNativeHistory: false`），只是按 bridge
自己的会话状态做兼容续接。

### 5.2 微信命令表

只支持文本；命令必须让整条消息以 `/` 开头，大小写不敏感：

| 命令 | 作用 |
|---|---|
| `/help` | 回复纯文本命令列表 |
| `/new`、`/reset` | 清空当前会话 + 轮次计数；下一条消息新建 DSH session |
| `/stop` | 中断当前正在执行的那次运行 |
| `/status` | agent / 模型 / cwd / 会话有无 / 是否运行中 / 轮次 / 运行时长 |

不在表内的命令（含 `/cd`、`/ws`、`/config`、`/resume`、`/invite`）回复：

```text
未知命令。发送 /help 查看可用命令；直接输入文字可与 DSH 对话。
```

其他行为：

- **引用消息**：长按引用再发送，bridge 把被引用内容以 `<quoted_message>` 注入 prompt（用户消息与 bot 回复
  都可解析）；缓存未命中退回内联文本，再没有就标注"内容不可用"。
- **进度提示**：运行开始后第 8 秒和第 20 秒各发一条 `⏳ 仍在执行（已 Ns，已调用工具 M 次）`，最多两条，
  结束不撤回（微信没有撤回接口）。
- **typing**：运行期间显示"正在输入"，4s 心跳；**结尾页脚**：`— 耗时 Xs · 工具 N 次`。
- **排队**：没有飞书那样的 600ms 合并窗口；运行中收到的每条消息各自排队、**串行**执行，长任务期间连发多条
  会依次处理。
- **出站预算**：单次运行最多 5 条出站消息（进度 + 终稿 + 错误），超出丢弃并记
  `run-outbound-budget-exhausted`；超长回复按 4000 字符分片（分片不计入该预算）。
- **轮次软提示**：见 §2.3（25 轮提示一次、50 轮起每条提示），不阻断。

### 5.3 默认 workspace 规则

1. profile 的 `workspaces.default` 是唯一权威：创建时传 `--workspace <path>` 则记录该目录 realpath（必须已
   存在）；不传则自动创建 `~/.lark-channel-workspaces/<profile>/default`（0700）。
2. 校验规则：必须是存在的目录，不能是文件系统根、Home 根、用户目录根、系统目录、临时目录根、
   `~/Desktop`、`~/Downloads` 这类过宽位置。
3. 运行时 cwd 解析顺序：`workspaces.json` 中该 scope 的 cwd → `workspaces.default`。
4. 飞书 `/cd` 写 `workspaces.json` 的 `chats[<scope>].cwd` 并重置会话；`/ws save|use` 维护命名目录。
   **微信没有任何命令能改 cwd**，只能改 `config.json` 的 `workspaces.default`（重启生效）或用
   `--workspace` 重建 profile。
5. 工作目录只是 agent 运行时的当前目录，**不是文件系统沙箱**；实际能写哪里由权限模式决定。
6. 两个 profile 共享同一 workspace 时：文件共享、会话不共享；并发运行可能互相覆盖文件，不建议。

### 5.4 权限模式与安全建议

| bridge 访问级别 | DSH `DSH_PERMISSION_MODE` | Claude | Codex |
|---|---|---|---|
| `full` | `danger-full-access` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `workspace-write` | `acceptEdits` | `workspace-write` |
| `read-only` | `read-only` | `plan` | `read-only` |

- 配置键是 `permissions.defaultAccess` / `permissions.maxAccess`；新建 profile 两者默认 `full`（保证本地工具、
  授权流程、文件写入完整可用）。旧配置的 `sandbox` 字段仍可读，保存时迁移到 `permissions`。
- 取值超出词汇表会直接报错，而不是悄悄放宽权限。

安全建议：

- 微信 bot 能在你的机器上执行代码，**默认收紧到 `workspace`**，只给它需要的项目目录；纯查看用 `read-only`。
- 不要把 `workspaces.default` 指到含密钥、证书、生产配置的目录（如 `~/.ssh`、`~/.lark-channel`）。
- `full` 模式下聊天里的一句话就可能改动系统文件；微信侧没有卡片确认，唯一的人工闸门是访问控制。

微信访问控制是 **fail-closed**：

```json
{
  "weixin": {
    "accounts": [{ "id": "your-bot-id@im.bot" }],
    "ownerId": "owner-ilink-user-id",
    "allowedUsers": ["friend-ilink-user-id"]
  }
}
```

- 首次 `weixin login` 把扫码者写成 `ownerId`（已有值不覆盖）。
- `allowedUsers` 为空 = **只有 owner** 能用；其他人的消息被静默丢弃（日志只记指纹，不记原始 id）。
- 没有 `/invite`，只能手工编辑 `config.json` 后重启 bridge。
- 访问控制只管"谁能触发"，不管"能改什么"；owner 同样受权限模式约束。

### 5.5 媒体、引用与进度能力现状

| 能力 | 飞书 | 微信 |
|---|---|---|
| 入站图片 / 文件 | 支持（下载到 `media/`，路径写入 prompt） | **未实现**：只提取文本 item；纯媒体消息回复"目前只支持文本消息" |
| 出站图片 / 文件 | 支持 | **未实现**：`image`/`file` payload 抛 `ChannelUnsupportedError` |
| 引用上下文 | 支持（拉原始消息 + 话题上下文） | 支持（本地引用缓存 + 内联兜底） |
| 流式输出 | 卡片流式 / markdown 流式 | 不支持（append-only） |
| typing | reaction `Typing` | `sendtyping`，4s 心跳 |
| 撤回 / 编辑 / 卡片 | 支持 | 不支持 |
| 群聊 / @ | 支持 | **不支持**（仅私聊） |
| Markdown | 卡片渲染 | 降级为纯文本（去围栏、链接、标题等标记） |

DSH 特有：`dsh --profile headless` 没有附件参数，飞书下载的附件只能以**本地路径**写进 prompt，由 agent
自己用工具读取；不存在原生图片通道。

## 6. 常见问题与排错

**6.1 微信不再回复，日志出现 `-14` / `token expired`**
iLink 没有 token 刷新机制，`ret/errcode = -14` 表示 bot token 失效：循环终止，日志出现
`weixin bot token expired`、`transport-stopped`。重新登录并重启（进程不会自动退出）：

```bash
lark-channel-bridge weixin login --profile wx
lark-channel-bridge restart --profile wx     # 前台运行则重新 run --profile wx
```

**6.2 `weixin login` 报 `binded_redirect`**
bot 已绑定到扫码的微信账号，服务端不再下发新凭证。这不是登录失败：本地既有凭证仍有效，直接
`run --profile wx` 即可。只有本地凭证丢失时才需重新绑定；本仓库没有解绑命令，请在微信客户端侧按服务端提示操作。

**6.3 长任务期间没有任何消息**
正常。typing 是唯一的过程信号，进度文本只在第 8s / 20s 各发一条，之后静默是设计如此（微信不能流式更新
卡片）。确认还活着：`/status` 看"运行中"，或看 `~/.lark-channel/profiles/<profile>/logs/`。

**6.4 `/stop` 之后又收到回复**
`/stop` 只中断**当前正在执行**的那次运行，已排队的消息仍会依次执行。清空上下文用 `/new`；停整个进程用
`lark-channel-bridge stop --profile wx`。

**6.5 两个 profile 能不能同时跑？**
能，前提是 profile 名不同且不共享渠道身份：同一微信账号不能被两个 profile 同时使用（渠道锁
`weixin:<ilink_bot_id>`）、同一飞书应用不能被两个 profile 同时连接、同一 profile 不能起两份（profile 锁）。
前台 `run` 遇到锁冲突会询问是否停掉占用者，非交互环境直接失败。

**6.6 怎么避免"会话混用"的误解**
记住**一个 profile 一条通路**：飞书聊的内容不会出现在微信，反之亦然；即使两个 profile 用同一 workspace，
也只是"同一批文件"，不是"同一个会话"。确认状态看各自 `/status`；切换上下文飞书用 `/new` / `/cd`，微信用 `/new`。

**6.7 DSH 相关错误**

- `MISSING_CREDENTIAL`：运行落到了 DSH 内置路由。确认 `<profileDir>/dsh/` 下两份覆盖文件都在，且
  `provider.apiKeyEnv` 指向的凭据存在。
- 找不到 `dsh`：必须在 `PATH` 上、记录在 `dsh.binaryPath`，或通过 `LARK_CHANNEL_DSH_BIN` 提供。
- `/stop` 后残留 `dsh` 进程：查日志 `stop-taskkill-failed`（`taskkill` 被权限拦截或 pid 被重新挂载）。
- 用了意料之外的模型：选中的 id 不在 `provider.models` 里，回退到了 `provider.defaultModel`。

**6.8 其他**

- `--web-ui` 报"微信渠道 profile 暂不支持控制面"：微信 profile 只能用 `run --profile` / `start --profile`。
- `run` 打印"已上线"后立刻退出：旧版本已知问题（Node 信号监听不保持事件循环），当前代码已修复；仍复现请
  确认跑的是最新构建。
- `weixin login` 卡住：确认在 TTY 中运行、网络可达 `ilinkai.weixin.qq.com`；二维码过期会自动刷新，共 3 次。
- `profile create` 报"非交互模式无法完成扫码创建应用"：飞书首次初始化需要 TTY，或改用 `--app-id`。

## 7. 已知限制与后续计划

### 7.1 微信通路

- **媒体未打通**：入站图片/文件/语音不解析（只处理文本 item）；出站图片/文件未实现。需要交付产物时，让
  agent 写到工作目录并在回复里给出路径。
- **仅私聊**：群聊、@ 提及、话题线程都不支持。
- **单账号**：只使用 `weixin.accounts[0]`，多账号登录/切换未实现。
- **无控制面**：`--web-ui` supervisor 与 Web 控制台不支持微信 profile。
- **无编辑能力**：append-only，不能流式、不能撤回、不能改消息；进度只能发文本且限条数。
- **命令子集**：没有 `/cd`、`/ws`、`/config`、`/resume`、`/invite`；模型和权限只能改配置文件。
- **轮次阈值写死**：`WEIXIN_MAX_SESSION_TURNS = 50` 目前是 runner 常量，计划改为 `weixin.maxSessionTurns`。
- **协议非公开**：iLink Bot CGI 无公开 SLA/文档，`context_token` 有效期、限频、风控行为需实测；账号存在
  风控/封号的不确定性，且**没有 token 刷新**，失效只能重新扫码。
- 代码注释里仍有 `P1.3` / `P1.4` 阶段标记，部分提示文案保留"后续版本支持"的措辞。

### 7.2 飞书通路（继承自上游 + 本 fork）

- DSH 没有原生图片输入通道；附件只以路径形式进入 prompt。
- `/resume` 无法枚举/重放 DSH 原生历史。
- DSH 冷缓存下 `dsh --version` 较慢，预检超时放宽到 20s。

### 7.3 后续计划（按代码中的 TODO 归纳）

1. 微信媒体：入站下载解密（`full_url` + `aeskey`）、出站上传与文件回传（P1.4）。
2. 微信群聊与多账号支持。
3. supervisor / Web 控制面接纳微信 profile。
4. 把轮次软提示阈值与进度节流参数暴露为 `weixin.*` 配置项。
5. 更完整的微信命令集（在文本能力下做降级菜单）。

## 附录 A：数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 根配置：所有 profile + `activeProfile` |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态（含 DSH session id） |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | 区分 agent 的会话目录 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前/命名工作目录绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密凭据 |
| `~/.lark-channel/profiles/<profile>/dsh/` | 生成的 DSH `--patch` 覆盖文件 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存（飞书） |
| `~/.lark-channel/profiles/<profile>/logs/` | 运行日志；守护进程日志在 `logs/daemon/` |
| `~/.lark-channel/profiles/<profile>/weixin/index.json` | 微信账号索引 |
| `~/.lark-channel/profiles/<profile>/weixin/accounts/<safeId>.json` | 微信 bot 凭证（0600，含 token） |
| `~/.lark-channel/profiles/<profile>/weixin/<safeId>.sync.json` | 长轮询游标 + 去重 message_id |
| `~/.lark-channel/profiles/<profile>/weixin/quotes.json` | 引用缓存（0600） |
| `~/.lark-channel/profiles/<profile>/weixin/turns.json` | 轮次计数（0600） |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 该 profile 的 lark-cli 配置目录（飞书） |
| `~/.lark-channel-workspaces/<profile>/default` | 自动创建的默认工作目录（0700） |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile 锁、app/渠道锁 |

## 附录 B：环境变量

| 变量 | 作用 |
|---|---|
| `LARK_CHANNEL_HOME` | 整体迁移本地状态根目录（默认 `~/.lark-channel`）；默认工作目录随之变为 `<root>-workspaces/` |
| `LARK_CHANNEL_DSH_BIN` | 指定 `dsh` 启动器路径，覆盖 `PATH` 自动发现（引导/检测都读） |
| `LARK_CHANNEL_LOG_DAYS` | 日志保留天数（默认 30） |
| `LARK_CHANNEL_CHANNEL` | **内部变量**：由微信运行路径设置，让 agent 拿到微信版系统提示词；不要手工设置 |
| `LARKSUITE_CLI_CONFIG_DIR` | 注入 agent 子进程，指向当前 profile 的 lark-cli 目录（飞书通路） |
| `DSH_PERMISSION_MODE` | 注入 DSH 子进程的权限模式，由 profile `permissions` 推导 |

> 常用排查顺序：`profile list` → `status --profile X` → 聊天内 `/status` →
> `~/.lark-channel/profiles/<profile>/logs/`。
