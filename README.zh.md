# im-agent-bridge

[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 的 fork，
新增 **DeepSeek Harness（DSH）** 作为第三种本机编程助手后端，与 Claude Code、Codex CLI 并列。

包名和命令行仍然是 `lark-channel-bridge`，所以上游的所有命令、斜杠命令和配置字段都照旧可用。
本仓库是功能超集，不是重写。

维护者：**罗孚传说（Rover Tang）** · <https://rovertang.com>

[English README](./README.md) · [上游原版 README（原样保留）](./README.upstream.zh.md) · [飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

---

## 为什么有这个 fork

上游 bridge 已经能把本机编程助手接进飞书 / Lark：流式卡片、`/cd` 与 `/ws` 工作目录、按会话隔离的上下文、
附件、交互卡片一应俱全。它没有覆盖的是 **DeepSeek Harness**。本 fork 补上这个后端，让 `dsh` 成为本机
agent 时也能用同一套聊天工作流。其余行为与上游一致——原版功能的完整说明仍以
[上游 README](./README.upstream.zh.md) 为准。

## 本 fork 增加了什么

### 1. 把 DeepSeek Harness 作为第三种 agent

在所有接受 agent 类型的地方，`dsh` 与 `claude`、`codex` 并列：`run`、`start`、`migrate` 的
`--agent dsh`，`profile create`，以及列出该 provider 模型列表的模型选择器。

```bash
lark-channel-bridge profile create dsh --agent dsh
lark-channel-bridge start --profile dsh
```

### 2. 基于 DSH session id 的会话延续

一次运行就是一个 `dsh --profile headless --json … -` 进程：任务从 stdin 传入，逐行的运行事件从 stdout
返回，进程随即退出。会话延续用的是 DSH 自己的不透明 `session-<uuid>`，通过 `--session-id` 原样回传，
因此 bridge 把 DSH 当作 Claude 那一类（session id）而不是 Codex 那一类（thread id）来处理。
`/new`、`/cd`、`/ws`、`/status`、`/stop` 的行为因此与 Claude Code 完全一致。

### 3. provider 和模型通过生成的覆盖文件传递

DSH 通过分层的 `--patch` 覆盖文件选择模型。每次运行前，适配器会把两份覆盖文件写进该 profile 自己的状态
目录，磁盘上的 DSH profile 不会被改写：

| 覆盖文件 | 声明内容 |
|---|---|
| `provider.patch.yml` | provider（id、API 家族、base URL、`apiKeyEnv`）及其模型列表 |
| `model-<hash>.patch.yml` | `agent-default-model`，为本次运行固定 provider 和模型 |

第二份覆盖文件**不是可选项**：`llm-pi-ai` 只是把你的 provider 注册为一条*额外*路由，而
`agent-default-model` 仍然指向 DSH 内置的 `deepseek-official`，所以只带 provider 覆盖文件的运行会以
`MISSING_CREDENTIAL` 失败。适配器总会固定一个有效模型——聊天里选中的那个，否则就是 provider 的
`defaultModel`。若选中的 id 不在声明的模型列表中，会回退到该默认模型，而不是让运行失败。

### 4. bridge 不保存你的 API Key

profile 里只声明「用哪个 provider」，密钥留在 DSH 自己那里。`apiKeyEnv`（出厂默认 `ONEAPI_API_KEY`）由 DSH
从自己的凭据存储解析，因此已有的 DSH 凭据会被直接复用，不会把密钥复制进 bridge 配置。

### 5. `/stop` 在 Windows 上终止整棵进程树

在 Windows 上 `dsh` 启动器通常是一个 `.cmd` 包装脚本，所以 bridge 真正持有的进程是 `cmd.exe` 而不是
DSH 本体。只杀掉包装脚本会把 DSH 变成孤儿进程，因此适配器用
`taskkill /PID <pid> /T /F` 终止整棵树——按绝对路径调用，因为守护进程可能在缺少 `System32` 的 `PATH`
下运行——宽限期过后仍存活则回退到 `SIGKILL`。其他平台使用 `SIGTERM`，并采用同样的兜底策略。

### 6. 用一处能力映射取代散落的 ternary

过去每个调用点都用 `agentKind === 'codex' ? … : …` 自行推导 agent 能力，任何新增的 agent 都会被悄悄
当成 Claude。现在由 `capabilityFor()` 和 `isSessionIdAgent()` 两个函数统一负责，将来增加第四种后端只需
改一行，而不必审查八个文件。同一轮改动还修掉了本 fork 否则一定会踩到的两个隐患：

- profile 序列化器只放行 `codex` 而没有放行 `dsh`，导致 `dsh` 块被写丢，下一次 `start` 会以
  *"dsh profile requires dsh configuration"* 失败；
- 会话目录用 `agentId === 'claude'` 分支，导致 DSH 条目落入 Codex 分支并在运行中途抛错，即使 agent
  已经成功，回复流也会被中断。

## 环境要求

- Node.js **>= 20.12.0** 以及 pnpm 10（`packageManager: pnpm@10.33.0`）。
- 一个可用的 `dsh` 安装，且已登录你要使用的 provider。用 `dsh --version` 确认。
- 一个飞书 / Lark **PersonalAgent** 应用。首次启动的扫码向导可以帮你创建并绑定。

Claude Code 和 Codex CLI 仍然完整支持；至少安装并登录一个 agent 即可。

## 安装

本 fork 没有发布到 npm，需要从源码构建：

```bash
git clone https://github.com/rovertang/im-agent-bridge.git
cd im-agent-bridge
pnpm install
pnpm build
```

`bin/lark-channel-bridge.mjs` 加载的是 `dist/cli.js`，所以必须构建成功后才能运行 CLI。要把
`lark-channel-bridge` 命令放进 `PATH`：

```bash
npm link
# 或者直接从检出目录运行
node bin/lark-channel-bridge.mjs --help
```

使用下面的服务命令前请先做全局安装：安装好的计划任务 / 服务单元会记录 CLI 路径，而来自临时缓存的路径
在缓存被清理后就会失效。`run` 通过 `npx` 以前台方式一次性运行没有问题。

## 首次运行

```bash
lark-channel-bridge run
```

首次运行会打开扫码向导：终端渲染二维码，用飞书 / Lark 扫码，选择或创建一个 PersonalAgent 应用，选择要
初始化的 agent，配置写入 `~/.lark-channel/config.json`。

不需要一开始就选定项目目录。bridge 会创建一个由 profile 管理的默认工作目录；启动后在飞书 / Lark 里发送
`/cd <path>` 即可切换到真实项目。

如果已经有 PersonalAgent 应用，传入 `--app-id` 跳过应用创建（命令会提示输入 App Secret）。Lark 国际版
应用再加 `--tenant lark`。

```bash
lark-channel-bridge run --app-id cli_xxx
lark-channel-bridge run --agent dsh                 # 初始化一个 DeepSeek Harness profile
lark-channel-bridge start --app-id cli_xxx          # 初始化并直接启动服务
```

## 后台服务

首次配置和前台调试用 `run`。确认 bot 能正常收发消息后，用 `Ctrl-C` 停掉前台进程，改用操作系统托管的后台
服务。服务命令安装的是**按 profile 区分的服务**：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

各平台对应关系：

- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：计划任务 `LarkChannelBridge.Bot.<profile>`，通过 `.cmd` 包装脚本启动

守护进程日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 多 profile

默认使用当前激活的 profile，用 `profile use <name>` 切换。每个 profile 维护独立的应用凭据、会话、工作
目录和日志。只有在需要连接多个 PersonalAgent 应用，或把多个 agent 作为不同的 bot 分别运行时，才需要创建
多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
lark-channel-bridge start --profile dsh --agent dsh
```

例如只重启 DeepSeek Harness 那个 bot：

```bash
lark-channel-bridge restart --profile dsh
lark-channel-bridge status --profile dsh
```

### profile 管理

```bash
lark-channel-bridge profile create dsh --agent dsh
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，包括当前激活的 profile。如果还有其他 profile，bridge 会切到下一个；
如果那是最后一个，根配置会被清空，以便同名 profile 可以重新创建。`--purge --yes` 会永久删除本地状态。
`profile export` 默认隐去应用密钥；`--include-secrets --yes` 会包含敏感配置。

如果某个 profile 创建时选错了 agent 类型，先停掉或注销与之匹配的后台服务，再执行 `profile remove <name>`，
然后用想要的 `--agent` 重建。

## 配置 DeepSeek Harness 后端

### 1. 让 profile 指向你的启动器

引导流程会解析 `dsh` 可执行文件并记录下来，通常不需要手工编辑。可以用环境变量或显式指定 agent 类型来覆盖
自动发现：

```bash
# 环境变量，引导流程和 `dsh` 检测都会读取
LARK_CHANNEL_DSH_BIN="C:\Users\me\AppData\Roaming\npm\dsh.cmd"

# 通过扫码向导初始化
lark-channel-bridge run --agent dsh

# 或者直接创建 profile
lark-channel-bridge profile create dsh --agent dsh
```

名为 `dsh` 的 profile 隐含 `dsh` 类型，所以 profile 名恰为 `dsh` 时 `--agent dsh` 可以省略。

### 2. 检查生成的 profile

```json
{
  "agentKind": "dsh",
  "dsh": {
    "binaryPath": "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd",
    "profile": "headless",
    "provider": {
      "id": "oneapi",
      "apiKeyEnv": "ONEAPI_API_KEY",
      "api": "openai-completions",
      "baseURL": "https://oneapi.example.com/v1",
      "defaultModel": "deepseek-v4.1-flash",
      "models": [{ "id": "deepseek-v4.1-flash" }, { "id": "GLM-5.2" }]
    }
  }
}
```

`binaryPath` 是唯一必填字段，其余都有可用的默认值。

> **你必须把 provider 指向自己的网关。** 内置的 `provider` 只是占位示例：`oneapi.example.com` 不是真实网关，
> `ONEAPI_API_KEY` 也不是真实凭据。请把 `provider.id`、`provider.api`、`provider.baseURL`、
> `provider.apiKeyEnv`、`provider.defaultModel` 和 `provider.models` 设为你自己那个兼容 OpenAI 协议的网关，
> 并确认你选用的凭据名存在于 DSH 自己的凭据存储（`$DSH_HOME/.credentials.yaml`）中。`defaultModel` 要保持在
> `models` 里。如果 provider 保持出厂状态，运行时无法通过认证。

### 3. `dsh` 配置项

| 字段 | 必填 | 默认值 | 含义 |
|---|---|---|---|
| `binaryPath` | 是 | — | `dsh` 启动器的绝对路径（Windows 上通常是 `.cmd` 包装脚本）。 |
| `profile` | 否 | `headless` | 要启动的 DSH profile。`headless` 回答一个任务后退出。 |
| `provider.id` | 否 | `oneapi` | 写进生成覆盖文件的 provider id。 |
| `provider.apiKeyEnv` | 否 | `ONEAPI_API_KEY` | DSH 从自己凭据存储解析的凭据名。 |
| `provider.api` | 否 | `openai-completions` | DSH 的 provider API 家族。 |
| `provider.baseURL` | 否 | `https://oneapi.example.com/v1` | provider 的 base URL（占位值，需替换）。 |
| `provider.defaultModel` | 否 | `deepseek-v4.1-flash` | 聊天未选择模型时固定的模型。 |
| `provider.models` | 否 | 6 个模型 | 选择器提供的列表，也是覆盖文件唯一允许固定的 id 集合。 |
| `patches` | 否 | — | 追加在生成覆盖文件之后的额外 `--patch` 覆盖，用于进一步调优 DSH。 |
| `dshHome` | 否 | 继承环境 | 子进程的 `DSH_HOME` 覆盖值。 |

`realpath`、`version`、`sha256`、`owner`、`mode` 会在引导时记录，用于诊断。

### 4. 启动

```bash
lark-channel-bridge run --agent dsh            # 前台运行，首次扫码向导
lark-channel-bridge start --profile dsh        # 操作系统托管的后台服务
lark-channel-bridge status --profile dsh
```

## 一次运行是怎么执行的

```text
dsh --profile headless --json \
    --patch ~/.lark-channel/profiles/dsh/dsh/provider.patch.yml \
    --patch ~/.lark-channel/profiles/dsh/dsh/model-<hash>.patch.yml \
    [--session-id session-<uuid>] -
```

有三项刻意不作为命令行参数：

- **工作目录**。DSH 从子进程的 cwd 推导会话工作区根目录和沙箱授权根目录，所以适配器直接在该次运行的 cwd
  里启动进程。这也是 `/cd` 和 `/ws` 能原样工作的原因。
- **权限模式**。DSH 从环境变量 `DSH_PERMISSION_MODE` 读取。
- **任务本体**。它从 stdin 传入，这样既让 bridge 那些多行长提示词（系统提示词 + 上下文 + 用户消息）不必
  出现在命令行上，也就避开了 Windows 会截断命令行的坑。

覆盖文件只在内容变化时才重写，位于 `~/.lark-channel/profiles/<profile>/dsh/`。

## 选择模型

在聊天里打开 `/config`，使用 **模型** 下拉框。`dsh` profile 的列表由该 profile 的 `provider.models` 加上
一个「跟随默认」选项构成：

| 选项 | 效果 |
|---|---|
| 跟随默认（`deepseek-v4.1-flash`） | 为本次运行固定 provider 的 `defaultModel`。 |
| 任意已声明的模型 id | 为本次运行固定该 id。 |

与 Claude、Codex 不同，「跟随默认」并不等于「不传模型」：DSH 仍然需要一个显式的 `agent-default-model`
覆盖文件，所以 provider 的默认模型会被明确写出。下拉列表是按 agent 类型静态生成的，因此手工编辑过的或过期
的 id 会回退到 `defaultModel`，而不会造成 unknown model 失败。

## 飞书 / Lark 内的斜杠命令

私聊不需要 `@`。群聊和话题群默认需要 `@bot`；`@all` 会被忽略。支持的文档类型里，在云文档评论中提及 bot
即可触发。

| 命令 | 作用 |
|---|---|
| `/new`、`/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作目录 |
| `/ws save <name>` | 把当前工作目录保存为命名工作目录 |
| `/ws use <name>` | 切换到某个命名工作目录 |
| `/ws remove <name>` | 删除某个命名工作目录 |
| `/resume` | 延续同一 agent、同一工作目录、同一权限模式下兼容的历史 |
| `/status` | 显示 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、模型、访问设置和 lark-cli 身份策略 |
| `/invite user @name` | 允许某用户在私聊中使用 bot |
| `/invite admin @name` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 已加入的所有群 |
| `/remove user @name`、`/remove admin @name`、`/remove group` | 移除访问条目 |
| `/stop` | 停止当前运行，卡片上的停止按钮同样有效 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的空闲看门狗 |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止某个 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [description]` | 运行低敏感度诊断 |
| `/help` | 帮助卡片 |

## 访问控制

聊天访问默认是私密的：开箱即用状态下只有应用创建者本人可以使用 bot，其他人的消息会被静默忽略。可以把人
或群加入三张名单之一：

| 名单 | 控制范围 | 添加 | 移除 |
|---|---|---|---|
| 允许的用户 | 谁可以和 bot 私聊 | `/invite user @对方` | `/remove user @对方` |
| 允许的群 | bot 在哪些群里回应 | `/invite group`（当前群）/ `/invite all group`（bot 已加入的所有群） | `/remove group` |
| 管理员 | 谁能改设置，以及在任意群里使用 bot | `/invite admin @对方` | `/remove admin @对方` |

`/invite` 和 `/remove` 只能由创建者和管理员执行，命令里的 `@` 指向目标用户而不是 bot。改动在**下一条消息**
即生效，无需重启。创建者永远不会把自己锁在外面——私聊 bot 发送 `/config` 即可恢复。

脚本化部署时，同样的名单位于 `~/.lark-channel/config.json` 中该 profile 的 `access` 字段（
`allowedUsers` 和 `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`）。空列表表示该名单中没有人，
而不是开放访问。手工编辑后需要重启 bridge 或发送 `/reconnect` 才会生效。

## 工作目录

每个 profile 可以通过 `workspaces.default` 定义默认工作目录。新建 profile 时可以带 `--workspace <path>`；
不传时 bridge 会创建一个由 profile 管理的默认工作目录。

以下是 profile 字段片段，不要用它整体替换 `config.json`；请编辑对应 profile 的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/dsh/default"
  }
}
```

bridge 会检查所选目录存在、是目录，且不是 `/`、用户主目录根、系统目录、临时目录根之类过宽的位置。工作目录
只是某次 agent 运行时的当前目录，它**不是**文件系统沙箱；实际的文件访问仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐的 profile 配置是 `permissions.defaultAccess` 与 `permissions.maxAccess`。新建 profile 两者都默认
为 `full`，以便本地工具、授权流程和文件写入保持完整可用。要收紧某个 profile，可把其中一个或两个设为
`workspace` 或 `read-only`。

以下是 profile 字段片段，不要用它整体替换 `config.json`；请编辑对应 profile 的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式对应关系：

| bridge 访问级别 | Claude 权限模式 | Codex 模式 | DSH `DSH_PERMISSION_MODE` |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` | `workspace-write` |
| `read-only` | `plan` | `read-only` | `read-only` |

DSH 的取值词汇与 bridge 完全一致，因此这里是经过校验的直通，而不是一张转换表：出现意料之外的取值会直接报错，
而不会悄悄放宽权限。

旧版 `sandbox` 字段对老配置仍然可读。bridge 保存该 profile 后，会把这个设置迁移到规范的 `permissions`。

## 云文档评论

云文档评论按文档权限生效：不需要单独绑定工作目录，也没有文档白名单。在支持的文档评论中提及 bot，bridge 会在
同一评论线程内回复。评论运行复用文档会话键；如果此前没有记录过该文档的工作目录，则回退到用户主目录。

## lark-cli 身份策略

每个 profile 使用自己独立的 lark-cli 目录，即当前 profile 的 lark-cli 目录
`~/.lark-channel/profiles/<profile>/lark-cli`。agent 进程会收到指向该目录的
`LARKSUITE_CLI_CONFIG_DIR`，因此一个 profile 里的个人授权不会与另一个 profile 共享。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为日历、邮件、云盘等个人资源授权
后，当前 profile 可以切换为 `user-default`，既保留应用身份，也允许已授权的用户身份。所有者 / 管理员可以在
`/config` 中查看或修改该策略；`/status` 会以 `lark-cli: app` 或 `lark-cli: user-ready` 显示当前摘要。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 根配置，包含各 profile 和当前激活的 profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | 区分 agent 的会话目录 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作目录绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密凭据 |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/dsh/` | 生成的 DSH `--patch` 覆盖文件 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile 与应用锁 |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以整体迁移本地状态。`LARK_CHANNEL_LOG_DAYS` 覆盖日志保留天数。

## 已知限制

- **没有原生图片输入。** `dsh --profile headless` 没有附件参数。bridge 仍会下载附件，并把本地路径写进
  prompt 的 `user_input`，因此 DSH 可以用自己的工具读取——但原生图片通道不会被使用；如果图片路径真的通过该
  通道传入，适配器会记录 `dsh-images-unsupported`。
- **`/resume` 无法浏览 DSH 历史。** DSH 确实会持久化自己的会话，但 bridge 既无法枚举也无法重新渲染它们
  （`supportsNativeHistory: false`）。bridge 改为维护自己的按会话状态，`/new`、`/cd` 和会话目录都基于它工作。
- **冷缓存下可用性检查较慢。** `dsh --version` 会经由 Electron 二进制启动打包的宿主，所以该后端的预检超时
  放宽到了 20 秒。

## 排错

**`MISSING_CREDENTIAL`。** 该次运行解析到了 DSH 内置的 `deepseek-official` 路由，而不是你的 provider。确认
`~/.lark-channel/profiles/<profile>/dsh/` 下两份覆盖文件都存在，并确认 `provider.apiKeyEnv` 指向的凭据确实
存在于你的 DSH 安装中。

**bot 一直不回复，或本机 CLI 从未返回。** 确认在与 bridge 相同的环境里 `dsh --version` 可用，并发送
`/status` 查看 profile、agent、工作目录和会话。`/new` 往往能通过开启新会话解决。

**找不到 `dsh`。** 它必须在 `PATH` 上，或记录在 `dsh.binaryPath` 里，或通过 `LARK_CHANNEL_DSH_BIN` 提供。

**`/stop` 之后仍有 `dsh` 进程残留。** 在日志里查 `stop-taskkill-failed`；`taskkill` 可能被权限拦截，或该 pid
已经被重新挂到别的父进程下。

**用了意料之外的模型。** 选中的 id 不在 `provider.models` 里，该次运行回退到了 `provider.defaultModel`。

**agent 子进程看起来卡住了。** bridge 支持空闲看门狗：如果 agent 在 N 分钟内没有任何输出，进程会被杀掉，卡片
上会标注自动终止的原因。该功能默认关闭；可以用 `/config` 全局开启，或对当前会话执行 `/timeout 10`。

## 开发

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

### 提交规则与密钥检查

每次 `git commit` / `git push` 都会自动执行 `tools/git-guard`（零依赖脚本）：检查密钥、私钥、
敏感文件、个人隐私信息、文件权限和推送目标。钩子文件在 `.githooks/` 中随仓库管理，每个克隆
执行一次安装：

```bash
pnpm hooks:install        # 或：node tools/git-guard/install.mjs
pnpm git:self-test        # 规则自检
pnpm git:check            # 全仓库扫描
```

完整规则、绕过策略与误报处理见 [`docs/GIT_COMMIT_RULES.md`](docs/GIT_COMMIT_RULES.md)。

`pnpm test` 覆盖单元、集成和进程级适配器测试。DSH 后端新增了针对性测试：

| 测试 | 覆盖内容 |
|---|---|
| `tests/unit/agent/dsh-argv.test.ts` | argv 构造与权限模式校验 |
| `tests/unit/agent/dsh-jsonl.test.ts` | DSH 的 NDJSON 运行事件翻译 |
| `tests/unit/agent/dsh-patches.test.ts` | 覆盖文件渲染与模型解析 |
| `tests/process/dsh-adapter.test.ts` | 用假启动器验证适配器契约 |
| `tests/process/dsh-live.test.ts` | 面向真实 DSH 安装的可选端到端测试 |

实机测试会消耗真实模型 token，未显式启用时会被跳过：

```powershell
$env:LARK_CHANNEL_DSH_LIVE = '1'
$env:LARK_CHANNEL_DSH_BIN  = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
pnpm test:process -- dsh-live
```

## 维护者

本 fork 由 **RoverTang** 维护。

- 博客：<https://rovertang.com>
- 公众号：**罗孚传说**
- GitHub：[@rovertang](https://github.com/rovertang)

与 DeepSeek Harness 后端相关的问题和 PR，欢迎提到
[本 fork](https://github.com/rovertang/im-agent-bridge/issues)。如果是 bridge 本身的问题，
请提到[上游项目](https://github.com/zarazhangrui/lark-coding-agent-bridge/issues)。

## 许可

[MIT](./LICENSE)，继承自上游项目。
