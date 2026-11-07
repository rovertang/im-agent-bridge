# im-agent-bridge

A fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
that adds **DeepSeek Harness (DSH)** as a third local coding-agent backend, alongside Claude Code and
Codex CLI.

The package name and the CLI stay `lark-channel-bridge`, so every upstream command, slash command, and
config field keeps working exactly as before. This fork is a superset, not a rewrite.

Maintained by **罗孚传说 (Rover Tang)** · <https://rovertang.com>

[中文 README](./README.zh.md) · [Upstream README, kept verbatim](./README.upstream.md) · [Feishu walkthrough](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

---

## Why this fork

The upstream bridge already lets you drive a local coding agent from Feishu / Lark: streaming cards,
`/cd` and `/ws` workspaces, per-chat sessions, attachments, interactive cards. What it did not cover was
**DeepSeek Harness**. This fork adds that backend, so the same chat workflow works when `dsh` is the
agent on your machine. Everything else is unchanged upstream behaviour — the
[upstream README](./README.upstream.md) remains the reference for the original feature tour.

## What this fork adds

### 1. DeepSeek Harness as a third agent kind

`dsh` joins `claude` and `codex` everywhere an agent kind is accepted: `--agent dsh` on `run`, `start`,
and `migrate`, plus `profile create`, plus a model picker that lists the DSH provider's models.

```bash
lark-channel-bridge profile create dsh --agent dsh
lark-channel-bridge start --profile dsh
```

### 2. Session continuity built on DSH session ids

One run is one `dsh --profile headless --json … -` process: the task arrives on stdin,
newline-delimited run events come back on stdout, and the process exits. Continuity comes from DSH's own
opaque `session-<uuid>`, replayed with `--session-id`, so the bridge treats DSH like Claude (a session
id) rather than like Codex (a thread id). `/new`, `/cd`, `/ws`, `/status`, and `/stop` therefore behave
exactly as they do for Claude Code.

### 3. Provider and model travel as generated overlays

DSH selects a model through layered `--patch` overlays. Before each run the adapter writes two of them
into the profile's own state directory, so the DSH profile on disk is never rewritten:

| Overlay | Declares |
|---|---|
| `provider.patch.yml` | The provider (id, API family, base URL, `apiKeyEnv`) and its model catalogue. |
| `model-<hash>.patch.yml` | `agent-default-model`, pinning the provider and model for this run. |

The second overlay is **not optional**: `llm-pi-ai` registers your provider as an *additional* route
while `agent-default-model` still points at DSH's built-in `deepseek-official`, so a run carrying only
the provider overlay fails with `MISSING_CREDENTIAL`. The adapter always pins an effective model — the
one selected in the chat, otherwise the provider's `defaultModel`. A model id outside the declared
catalogue degrades to that default instead of failing the run.

### 4. The bridge never holds your API key

The profile points at a provider; the secret stays where DSH already keeps it. `apiKeyEnv` (shipped
default `ONEAPI_API_KEY`) is resolved by DSH from its own credential store, so an existing DSH
credential is reused as-is and no key is copied into the bridge config.

### 5. `/stop` terminates the whole process tree on Windows

On Windows the `dsh` launcher is usually a `.cmd` shim, so the process the bridge owns is `cmd.exe`
rather than the real host. Killing the shim alone would orphan DSH, so the adapter terminates the tree
with `taskkill /PID <pid> /T /F` — invoked by absolute path, because a daemon can run with a `PATH`
that omits `System32` — and falls back to `SIGKILL` if that grace expires. Elsewhere it uses `SIGTERM`
with the same bounded fallback.

### 6. One capability map instead of scattered ternaries

Every call site used to re-derive an agent's capability with `agentKind === 'codex' ? … : …`, which
silently mislabelled any newly added agent as Claude. Two helpers now own that decision —
`capabilityFor()` and `isSessionIdAgent()` — so adding a fourth backend is a one-line change instead of
an audit of eight files. The same pass fixed two latent bugs this fork would otherwise have hit:

- the profile serializer whitelisted `codex` but not `dsh`, so the `dsh` block was written away and the
  next `start` failed with *"dsh profile requires dsh configuration"*;
- the session catalog branched on `agentId === 'claude'`, so DSH entries fell into the Codex branch and
  threw mid-run, aborting the reply stream even though the agent had succeeded.

## Requirements

- Node.js **>= 20.12.0** and pnpm 10 (`packageManager: pnpm@10.33.0`).
- A working `dsh` installation, already signed in to the provider you want to use. Verify with
  `dsh --version`.
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

Claude Code and Codex CLI remain fully supported; you need at least one agent installed and logged in.

## Install

This fork is not published to npm, so build it from source:

```bash
git clone https://github.com/rovertang/im-agent-bridge.git
cd im-agent-bridge
pnpm install
pnpm build
```

`bin/lark-channel-bridge.mjs` loads `dist/cli.js`, so the CLI only runs after a successful build. To get
the `lark-channel-bridge` command on your `PATH`:

```bash
npm link
# or run it straight from the checkout
node bin/lark-channel-bridge.mjs --help
```

Install globally before using the service commands below: the installed task/unit records the CLI path,
and a path that comes from a temporary cache breaks when that cache is cleaned. `run` is fine through
`npx` as a one-shot foreground process.

## First run

```bash
lark-channel-bridge run
```

The first run opens a QR-code wizard: a QR code renders in your terminal, you scan it with the
Feishu / Lark app, pick or create a PersonalAgent app, choose which agent to initialize, and the config
is written to `~/.lark-channel/config.json`.

You do not need to choose a project directory up front. The bridge creates a profile-managed default
working directory; afterwards send `/cd <path>` in Feishu / Lark to switch to a real project.

If you already have a PersonalAgent app, pass `--app-id` to skip app creation (the command prompts for
the App Secret). For Lark global apps, add `--tenant lark`.

```bash
lark-channel-bridge run --app-id cli_xxx
lark-channel-bridge run --agent dsh                 # initialize a DeepSeek Harness profile
lark-channel-bridge start --app-id cli_xxx          # initialize and start the service directly
```

## Background service

Use `run` for first-run setup and foreground debugging. Once the bot can send and receive messages, stop
the foreground process with `Ctrl-C` and use an OS-managed service instead. Service commands install a
**per-profile service**:

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

Platform mapping:

- **macOS**: launchd user agent `ai.lark-channel-bridge.bot.<profile>`
- **Linux**: systemd user unit `lark-channel-bridge.bot.<profile>.service`
- **Windows**: Task Scheduler task `LarkChannelBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.lark-channel/profiles/<profile>/logs/daemon/`.

### Multiple profiles

By default the bridge starts with the currently selected profile; `profile use <name>` changes it. Each
profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles
only when you need to connect multiple PersonalAgent apps, or run several agents as separate bots:

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
lark-channel-bridge start --profile dsh --agent dsh
```

For example, to restart only the DeepSeek Harness bot:

```bash
lark-channel-bridge restart --profile dsh
lark-channel-bridge status --profile dsh
```

### Profile management

```bash
lark-channel-bridge profile create dsh --agent dsh
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` archives local state by default, including the active profile. If other profiles
remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so
the same name can be created again. `--purge --yes` permanently deletes local state. `profile export`
redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service
first, then run `profile remove <name>` and recreate it with the intended `--agent`.

## Configure the DeepSeek Harness backend

### 1. Point the profile at your launcher

Bootstrap resolves the `dsh` executable and records it, so usually nothing needs editing by hand.
Override discovery with an environment variable or an explicit agent kind:

```bash
# environment variable, honored by bootstrap and by `dsh` detection
LARK_CHANNEL_DSH_BIN="C:\Users\me\AppData\Roaming\npm\dsh.cmd"

# initialize through the QR wizard
lark-channel-bridge run --agent dsh

# or create the profile up front
lark-channel-bridge profile create dsh --agent dsh
```

A profile named `dsh` implies the `dsh` agent kind, so `--agent dsh` is optional when the profile name
is exactly `dsh`.

### 2. Review the generated profile

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

`binaryPath` is the only required field; everything else has a working default.

> **You must point the provider block at your own gateway.** The shipped `provider` is a placeholder:
> `oneapi.example.com` is not a real gateway and `ONEAPI_API_KEY` is not a real credential. Set
> `provider.id`, `provider.api`, `provider.baseURL`, `provider.apiKeyEnv`, `provider.defaultModel`,
> and `provider.models` for your own OpenAI-compatible gateway, and make sure the credential name you
> choose exists in DSH's own credential store (`$DSH_HOME/.credentials.yaml`). Keep `defaultModel`
> inside `models`. A run whose provider was left as shipped cannot authenticate.

### 3. `dsh` config reference

| Field | Required | Default | Meaning |
|---|---|---|---|
| `binaryPath` | yes | — | Absolute path to the `dsh` launcher (a `.cmd` shim on Windows). |
| `profile` | no | `headless` | DSH profile to boot. `headless` answers one task and exits. |
| `provider.id` | no | `oneapi` | Provider id written into the generated overlay. |
| `provider.apiKeyEnv` | no | `ONEAPI_API_KEY` | Credential name DSH resolves from its own store. |
| `provider.api` | no | `openai-completions` | DSH provider API family. |
| `provider.baseURL` | no | `https://oneapi.example.com/v1` | Provider base URL (placeholder — replace it). |
| `provider.defaultModel` | no | `deepseek-v4.1-flash` | Model pinned when the chat selects none. |
| `provider.models` | no | 6 models | Catalogue offered by the picker, and the only ids an overlay may pin. |
| `patches` | no | — | Extra `--patch` overlays applied after the generated ones, for further DSH tuning. |
| `dshHome` | no | inherited | `DSH_HOME` override for the child process. |

`realpath`, `version`, `sha256`, `owner`, and `mode` are recorded at bootstrap for diagnostics.

### 4. Start it

```bash
lark-channel-bridge run --agent dsh            # foreground, first-run QR wizard
lark-channel-bridge start --profile dsh        # OS-managed background service
lark-channel-bridge status --profile dsh
```

## How one run is executed

```text
dsh --profile headless --json \
    --patch ~/.lark-channel/profiles/dsh/dsh/provider.patch.yml \
    --patch ~/.lark-channel/profiles/dsh/dsh/model-<hash>.patch.yml \
    [--session-id session-<uuid>] -
```

Three things are deliberately not flags:

- **The working directory.** DSH derives its session workspace root and the sandbox's authorized root
  from the child's cwd, so the adapter spawns in the run's cwd. That is what makes `/cd` and `/ws` work
  unchanged.
- **The permission mode.** DSH reads `DSH_PERMISSION_MODE` from the environment.
- **The task.** It arrives on stdin, which keeps long multi-line bridge prompts (system prompt + context
  + user message) off the command line where Windows would truncate them.

The overlays are rewritten only when their content changes, and they live in
`~/.lark-channel/profiles/<profile>/dsh/`.

## Selecting a model

Open `/config` in the chat and use the **Model** dropdown. For a `dsh` profile the list is built from
the profile's `provider.models`, plus a *follow the default* entry:

| Option | Effect |
|---|---|
| follow the default (`deepseek-v4.1-flash`) | The provider's `defaultModel` is pinned for the run. |
| any declared model id | That id is pinned for the run. |

Unlike Claude and Codex, "follow the default" does not mean "pass no model": DSH still needs an explicit
`agent-default-model` overlay, so the provider default is written out. The dropdown's option list is
static per agent kind, so a hand-edited or stale id falls back to `defaultModel` rather than producing
an unknown-model failure.

## Slash commands inside Feishu / Lark

DMs do not require an `@` mention. Groups and topic groups require `@bot` by default; `@all` is ignored.
Cloud-doc comments in supported document types run when the bot is mentioned.

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current session |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume` | Resume compatible history for the same agent, working directory, and permission mode |
| `/status` | Show profile, agent, working directory, session, lark-cli identity, and run state |
| `/config` | Adjust presentation preferences, model, access settings, and lark-cli identity policy |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/help` | Help card |

## Access control

Chat access is private by default: out of the box only the app's creator can use the bot. Everyone else
is silently ignored. Add people and groups to one of three lists:

| List | Controls | Add | Remove |
|---|---|---|---|
| Allowed users | Who can DM the bot | `/invite user @them` | `/remove user @them` |
| Allowed chats | Which groups the bot answers in | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` |
| Admins | Who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

`/invite` and `/remove` can only be run by the creator and admins, and the `@` points at the target
person, not the bot. Changes take effect on the next message; no restart needed. The creator can never
lock themselves out — DM the bot and send `/config` to get back in.

For scripted deployment, the same lists live in the profile's `access` field of
`~/.lark-channel/config.json` (`allowedUsers` and `admins` take user `open_id`s, `allowedChats` takes
group `chat_id`s). Empty lists mean nobody from that list, not open access. After a manual edit, restart
the bridge or send `/reconnect` to apply it.

## Working directories

Each profile may define a default working directory through `workspaces.default`. New profiles may be
created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working
directory.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching
profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/dsh/default"
  }
}
```

The bridge checks that a selected directory exists, is a directory, and is not an overly broad location
such as `/`, the home root, a system directory, or a temp root. The working directory is only the
current directory for an agent run. It is not a filesystem sandbox; actual file access still depends on
the local agent process and its permission mode.

## Permission modes

The recommended profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles
default to `full` for both, so the bridge can keep local tools, authorization flows, and file writes
fully usable. To tighten a profile, set one or both to `workspace` or `read-only`.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching
profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode | DSH `DSH_PERMISSION_MODE` |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` | `workspace-write` |
| `read-only` | `plan` | `read-only` | `read-only` |

The DSH vocabulary is identical to the bridge's, so it is a validated pass-through rather than a
translation table: an unexpected value fails loudly instead of silently widening access.

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it
migrates that setting to canonical `permissions`.

## Cloud-doc comments

Cloud-doc comments are document-scoped: they need no separate workspace binding and no document
allowlist. In supported document comments, mention the bot and the bridge replies in the same thread.
Comment runs reuse the document session key and fall back to the user home directory when no document
working directory was previously recorded.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at
`~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for
that directory, so personal authorization in one profile is not shared with another.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does not access personal
resources. When a user authorizes personal resources such as calendar, mail, or drive, the current
profile can switch to `user-default`, which keeps app identity available and also allows the authorized
user identity. Owner/admin users can inspect or change this policy in `/config`; `/status` shows the
current summary as `lark-cli: app` or `lark-cli: user-ready`.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Root config with profiles and active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/dsh/` | Generated DSH `--patch` overlays |
| `~/.lark-channel/profiles/<profile>/media/` | Attachment cache |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `~/.lark-channel/registry/processes.json` | Local process registry |
| `~/.lark-channel/registry/locks/` | Profile and app locks |

Set `LARK_CHANNEL_HOME=/path/to/state` to move all local bridge state. `LARK_CHANNEL_LOG_DAYS`
overrides log retention.

## Known limitations

- **No native image input.** `dsh --profile headless` has no attachment flag. Attachments are still
  downloaded by the bridge and their local paths are embedded in the prompt's `user_input`, so DSH can
  read them with its own tools — but the native image channel is not used, and the adapter logs
  `dsh-images-unsupported` if image paths are ever supplied that way.
- **`/resume` cannot browse DSH history.** DSH does persist its own sessions, but the bridge cannot
  enumerate or re-render them (`supportsNativeHistory: false`). It keeps its own per-chat session
  instead, which is what `/new`, `/cd`, and the session catalog operate on.
- **Availability checks are slow on a cold cache.** `dsh --version` boots the packaged host through the
  Electron binary, so the preflight timeout is raised to 20 s for this backend.

## Troubleshooting

**`MISSING_CREDENTIAL`.** The run resolved to DSH's built-in `deepseek-official` route instead of your
provider. Confirm both overlays exist under `~/.lark-channel/profiles/<profile>/dsh/` and that
`provider.apiKeyEnv` names a credential your DSH install actually stores.

**The bot stays silent or the local CLI never replies.** Check that `dsh --version` works in the same
environment as the bridge, and send `/status` to inspect the profile, agent, working directory, and
session. `/new` often fixes it by starting a fresh session.

**`dsh` was not found.** It must be on `PATH`, recorded as `dsh.binaryPath`, or supplied through
`LARK_CHANNEL_DSH_BIN`.

**`/stop` leaves a `dsh` process behind.** Check the log for `stop-taskkill-failed`; `taskkill` can be
blocked by permissions or by a pid that was already reparented.

**An unexpected model is used.** The selected id was not in `provider.models`, so the run fell back to
`provider.defaultModel`.

**The agent subprocess looks frozen.** The bridge supports an idle watchdog: if the agent emits nothing
for N minutes, the process is killed and the card is annotated with the auto-termination reason.
Disabled by default; enable it with `/config` or `/timeout 10` for the current session.

## Development

Local checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

### Commit hooks and secret scanning

Every `git commit` / `git push` runs `tools/git-guard` — a zero-dependency check for secrets,
private keys, sensitive files, personal data, file permissions and the push target. Install the
hooks once per clone (they live in `.githooks/`, which is versioned):

```bash
pnpm hooks:install        # or: node tools/git-guard/install.mjs
pnpm git:self-test        # rule self-test
pnpm git:check            # full-repository scan
```

Rules, bypass policy and false-positive handling: [`docs/GIT_COMMIT_RULES.md`](docs/GIT_COMMIT_RULES.md).

`pnpm test` includes unit, integration, and process-level adapter tests. The DSH backend adds focused
coverage:

| Test | Covers |
|---|---|
| `tests/unit/agent/dsh-argv.test.ts` | argv construction and permission-mode validation |
| `tests/unit/agent/dsh-jsonl.test.ts` | translation of DSH's NDJSON run events |
| `tests/unit/agent/dsh-patches.test.ts` | overlay rendering and model resolution |
| `tests/process/dsh-adapter.test.ts` | the adapter contract against a fake launcher |
| `tests/process/dsh-live.test.ts` | opt-in end-to-end run against a real DSH install |

The live test spends real model tokens and is skipped unless explicitly enabled:

```powershell
$env:LARK_CHANNEL_DSH_LIVE = '1'
$env:LARK_CHANNEL_DSH_BIN  = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
pnpm test:process -- dsh-live
```

## Maintainer

This fork is maintained by **RoverTang**.

- Website: <https://rovertang.com>
- WeChat official account: **罗孚传说**
- GitHub: [@rovertang](https://github.com/rovertang)

Issues and pull requests about the DeepSeek Harness backend are welcome on
[this fork](https://github.com/rovertang/im-agent-bridge/issues). For anything about the
original bridge itself, please use the
[upstream project](https://github.com/zarazhangrui/lark-coding-agent-bridge/issues).

## License

[MIT](./LICENSE), inherited from the upstream project.
