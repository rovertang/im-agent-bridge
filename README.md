# im-agent-bridge

Connect your IM chats to local coding agents. **Feishu / Lark** and **WeChat (iLink / ClawBot)** are
bridged to **Claude Code**, **Codex CLI**, or **DeepSeek Harness (DSH)** running on your own machine:
a chat message becomes one local agent run, run events are rendered back into the chat, and sessions
are persisted per chat scope.

This is a fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge).
The package name and the CLI stay `lark-channel-bridge`, so every upstream command, slash command and
config field keeps working. Upstream features are all preserved — this fork is a superset.

Maintained by **Rover Tang (罗孚传说)** · <https://rovertang.com>

[中文 README](./README.zh.md) · [Full usage guide](./USAGE.zh.md) · [Upstream README](./README.upstream.md)

## What this fork adds

- **DeepSeek Harness backend.** `dsh` joins `claude` and `codex`: session continuity through DSH
  session ids, provider/model selected through generated `--patch` overlays, and the API key stays in
  DSH's own credential store — the bridge never copies it.
- **WeChat iLink channel.** A second channel next to Feishu: text DMs, typing indicator, quoted-message
  context, progress messages, rate limiting and gentle turn-count reminders.
- **Channel abstraction (`ChannelPort`).** Feishu and WeChat are two implementations of one port, so
  adding another IM later is a small, contained change.

## Two channels, independent by design

| | Feishu / Lark | WeChat iLink |
|---|---|---|
| Binding | PersonalAgent app (QR wizard, or existing App ID + Secret) | ClawBot account (scan QR in terminal) |
| Transport | WebSocket | HTTP long polling |
| Messages | cards, markdown, streaming, recall, reactions | plain text only, append-only, typing |
| Chat commands | full set: `/new`, `/cd`, `/ws`, `/status`, `/config`, `/invite`, `/stop`, … | `/help`, `/new`, `/reset`, `/stop`, `/status` |
| Groups & docs | groups, topic groups, cloud-doc comments | DMs only, one account |
| Access control | users / chats / admins | `weixin.ownerId` + `weixin.allowedUsers` |
| Daemon | `start/stop/restart/status/unregister`; supports the `--web-ui` control plane | same commands, no `--web-ui` |

Each profile belongs to one channel and one agent. **Sessions are never shared between the two
channels**: `/new` and `/stop` only affect their own channel. Two profiles may point at the same
workspace directory (files are shared), but that is not recommended.

## Requirements

- Node.js **>= 20.12.0** and pnpm 10.
- At least one agent installed and logged in: `claude`, `codex`, or `dsh` (for DSH, `dsh --version`
  must work).
- Feishu / Lark: a PersonalAgent app — the QR wizard can create and bind one.
- WeChat: a WeChat client with ClawBot / iLink capability; the login QR code needs a TTY.

## Install

This fork is not published to npm, so build it from source:

```bash
git clone https://github.com/rovertang/im-agent-bridge.git
cd im-agent-bridge
pnpm install
pnpm build
npm link        # optional; otherwise run: node bin/lark-channel-bridge.mjs <cmd>
```

`start` records the CLI path, so install the CLI globally before using the background-service commands.

## Quick start

### Feishu / Lark

```bash
lark-channel-bridge profile create feishu --agent dsh   # QR wizard: scan to create/bind the app
lark-channel-bridge run --profile feishu                # foreground, verify it answers
lark-channel-bridge start --profile feishu              # install as a background service
```

Already have an app? Pass `--app-id cli_xxxxxxxxxxxx` to skip app creation (add `--tenant lark` for
Lark international). Use `--agent claude` or `--agent codex` if that is the backend you want.

### WeChat iLink

```bash
lark-channel-bridge profile create wx --channel weixin --agent dsh
lark-channel-bridge weixin login --profile wx           # scan the QR code, confirm the number if asked
lark-channel-bridge run --profile wx                    # foreground, prints "微信渠道已上线"
lark-channel-bridge start --profile wx                  # install as a background service
```

### Background service and profiles

```bash
lark-channel-bridge start|stop|restart|status|unregister [--profile <name>]
lark-channel-bridge profile list|use|remove|export <name>
```

Services are per profile: macOS launchd, Linux systemd user units, Windows Task Scheduler. Several
profiles can run side by side (for example one for Feishu and one for WeChat), each with its own
credentials, sessions, working directories and logs. `profile list` shows each profile's channel,
agent and running pid.

## Documentation

- **[USAGE.zh.md](./USAGE.zh.md)** — the full manual (Chinese): architecture and both channels,
  binding/initialization, daily command reference, default workspaces, permissions and security,
  media/quote/progress support, troubleshooting, known limitations and data directories.
- [README.upstream.md](./README.upstream.md) / [README.upstream.zh.md](./README.upstream.zh.md) —
  the upstream bridge docs, kept verbatim for inherited features.
- [Feishu walkthrough](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)
- [docs/GIT_COMMIT_RULES.md](./docs/GIT_COMMIT_RULES.md) — commit/push rules and secret scanning.

## Development

```bash
pnpm test            # unit + integration + process tests
pnpm typecheck
pnpm build
pnpm hooks:install   # install git-guard commit/push hooks (once per clone)
pnpm ci:local        # full pre-push check: rules + tests + typecheck + build
```

## Maintainer & license

Maintained by **Rover Tang (罗孚传说)** · <https://rovertang.com> · WeChat official account **罗孚传说**.
Issues and pull requests about the DSH backend or the WeChat channel are welcome on
[this fork](https://github.com/rovertang/im-agent-bridge/issues); anything about the original bridge
belongs to the [upstream project](https://github.com/zarazhangrui/lark-coding-agent-bridge/issues).

[MIT](./LICENSE), inherited from the upstream project.
