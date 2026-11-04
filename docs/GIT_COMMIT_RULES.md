# Git 提交与推送规则

本文件是本仓库的强制规则。配套的自动检查由 `tools/git-guard/`（零依赖 Node 脚本）实现，
通过 `.githooks/` 挂在 `pre-commit`、`commit-msg`、`pre-push` 三个钩子上执行。

> 一句话：**任何提交、推送之前，先通过隐私、权限、密钥、敏感信息检查。**

---

## 1. 适用范围

| 场景 | 检查 | 是否阻断 |
| --- | --- | --- |
| `git commit` | 暂存区内容 + 文件名 + 权限位 + 提交身份 | 命中 error 阻断 |
| `git commit` | 提交信息（防止把密钥、内网地址粘进 message） | 命中 error 阻断 |
| `git push` | 远端白名单 + SSH 私钥权限 + 待推送的提交/文件 | 命中 error 阻断 |
| CI | `--self-test`（规则自检）+ `--all`（全仓库扫描） | 命中 error 失败 |
| 手动 | `pnpm git:check` | 命中 error 退出码 1 |

下游 fork / 二次开发者同样适用；规则文件随仓库走，不依赖任何外部服务。

---

## 2. 一次性安装钩子

钩子文件在 `.githooks/`，但 `core.hooksPath` 属于本地配置，**新克隆后必须执行一次**：

```bash
pnpm hooks:install     # 等价于 node tools/git-guard/install.mjs
pnpm hooks:check       # 检查是否安装就绪
```

> 没有 pnpm 时，所有命令都可以用 `npm run <script>` 或直接 `node tools/git-guard/...` 执行，
> 例如 `npm run hooks:install`。脚本本身只依赖 Node ≥ 20，不依赖任何包管理器。

安装后 `git config --local core.hooksPath` 应为 `.githooks`。

> 如果 clone 后没有安装钩子，`git commit / git push` 不会自动检查，等同于裸奔。
> 请把这一步写进你的开发环境初始化脚本。

---

## 3. 提交前必须确认的检查项

### 3.1 密钥与凭据（error，直接阻断）

| 规则 | 检查内容 |
| --- | --- |
| `secret/private-key` | `-----BEGIN … PRIVATE KEY-----` 私钥块 |
| `secret/github-token` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_` |
| `secret/llm-api-key` | `sk-`、`sk-proj-`、`sk-ant-` 等 LLM API Key |
| `secret/aws-key` | `AKIA…` / `ASIA…` |
| `secret/google-api-key` | `AIza…` |
| `secret/slack-token` | `xox…` |
| `secret/url-credentials` | `postgres://user:pass@host` 之类内嵌口令的 URL |
| `secret/env-style` | `.env` 风格的 `*_SECRET=` / `*_TOKEN=` / `*_KEY=` 赋值 |
| `secret/generic-assignment` | 引号包裹、且字符类别熵足够高的硬编码密钥赋值 |

### 3.2 敏感文件（error，直接阻断）

`.env` 系列、`.npmrc`、`.netrc`/`.git-credentials`/`.pgpass`、SSH 私钥（`id_rsa`/`id_ed25519`…）、
`*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.kdbx`、`.aws/credentials`、
`credentials.*`/`secrets.*`、`.DS_Store`/`Thumbs.db`、`node_modules/`。

允许的例外：`.env.example`、`.npmrc.example`、`*.pem.example` 等模板文件。

### 3.3 隐私信息（warn，默认放行但建议处理）

- 绝对家目录路径：`/Users/<name>/`、`/home/<name>/`、`C:\Users\<name>\`
- 真实邮箱地址（`example.com/org/net` 等示例域自动放行）
- 中国大陆手机号、身份证号
- 内网 IP（`10.x`、`192.168.x`、`172.16-31.x`）

### 3.4 权限（error / warn）

- `key/ssh-permissions`（error）：`~/.ssh/id_*` 权限不是 `600` → `chmod 600 ~/.ssh/id_*`
- `key/ssh-missing`（warn）：SSH 推送但找不到私钥
- `perm/world-writable`（error）：文件对所有人可写
- `perm/symlink-escape`（error）：符号链接指向仓库外（可能把本机文件带进仓库）
- `perm/unexpected-exec`（warn）：非 `bin/`、`*.sh`、`.githooks/`、`tools/*.mjs` 的文件带可执行位
- `file/too-large`（error）：单文件超过 2 MiB
- `file/forced-ignored`（warn）：`git add -f` 强行加入了本应被忽略的文件

### 3.5 推送目标白名单（error）

`pre-push` 只允许推送到 `origin`（本仓库 `rovertang/lark-coding-agent-bridge-dsh`）。
`upstream`（`zarazhangrui/lark-coding-agent-bridge`）**是只读上游**，禁止推送。
如需推送到其他 fork，请在 `.gitguardignore` 中用 `remote:<正则>` 显式登记。

---

## 4. 手动检查命令

```bash
pnpm git:check          # 全仓库扫描（等价 --all）
pnpm git:self-test      # 规则自检（22+ 用例，改动规则后必跑）
pnpm hooks:check        # 钩子安装状态
node tools/git-guard/check.mjs --staged              # 只检查暂存区
node tools/git-guard/check.mjs --list-rules          # 列出全部规则 id
node tools/git-guard/check.mjs --all --json          # 机器可读输出
node tools/git-guard/check.mjs --all --strict        # 警告也算失败
```

---

## 5. 误报处理（`.gitguardignore`）

**优先改代码**（换成环境变量、改成示例值）。确认是误报才放行，并在文件里写清原因：

| 指令 | 作用 |
| --- | --- |
| `rule:<id>` | 全局关闭某条规则（保守使用） |
| `path:<glob>` | 跳过匹配路径的内容扫描，如 `path:tests/fixtures/**` |
| `line:<子串>` | 跳过包含该子串的行，适合单行示例 |
| `remote:<正则>` | 额外允许推送的远端地址 |
| `email:<地址>` | 允许出现的邮箱 |
| `home-user:<用户名>` | 允许出现在绝对路径中的用户名 |
| `max-bytes:<数值>` | 调整单文件大小上限 |

放行必须限定范围，禁止用 `rule:` 关掉整类密钥规则来"图省事"。

---

## 6. 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)，与现有历史保持一致：

```
<type>(<scope>): <subject>

<body 可选：说明动机、权衡、影响范围>
```

- `type`：`feat` `fix` `chore` `docs` `refactor` `test` `perf` `build` `ci` `style` `revert`
- `scope`：模块名，如 `agent`、`daemon`、`web`、`dsh`
- `subject`：一句话、≤ 72 字符、不加句号
- 提交信息同样过密钥/隐私扫描：**不要粘贴 token、内网地址、真实用户数据**；需要贴日志先脱敏
- 一个提交只做一件事；大改动拆成可 review 的多个提交

---

## 7. 分支与推送纪律

- 默认分支 `main`：可以直推（当前未开分支保护），但**建议**走 `feat/*`、`fix/*` 分支 + PR
- 分支命名：`feat/<简述>`、`fix/<简述>`、`chore/<简述>`
- **禁止** `git push --force` / `--force-with-lease` 到 `main`
- **禁止**推送到 `upstream`（只读上游）
- 推送前本地跑：`pnpm ci:local`（`git diff --check` + 规则检查 + 测试 + 类型检查 + 构建）
- 提交前确认 `git status` 里没有意外文件（尤其是 `.env*`、`dist/`、`tmp/`）

---

## 8. 密钥与权限管理

- **任何真实密钥都不得进入仓库**，包括测试文件、文档、截图、commit message、PR 描述
- 密钥来源统一走环境变量或本地密钥库（`.env` 已被 `.gitignore` 忽略）
- SSH 私钥权限必须是 `600`；`~/.ssh/config` 建议 `600`
- 每台机器使用独立密钥，便于单点吊销；GitHub 上按 key 备注机器名
- 定期轮换 Lark app secret / GitHub token；泄露后立即轮换，而不是只删提交
- 需要示例时用占位符：`your_app_secret_here`、`${APP_SECRET}`、`sk-xxxx…`

---

## 9. 误提交应急流程

1. **立即轮换**被提交的密钥（GitHub / Lark / 云厂商控制台），假设它已泄露
2. 删除远端历史中的敏感内容（`git filter-repo` 或 BFG），不要只 `git rm` 了事——历史里仍然可查
3. 强制推送清洗后的历史，并通知所有协作者重新 clone
4. 检查 CI 日志、Actions artifacts 是否也包含泄露内容
5. 复盘：为什么钩子没拦住？（未安装钩子 / `GIT_GUARD_SKIP=1` / 规则漏检）→ 补规则或补流程

---

## 10. 绕过与合规

- `GIT_GUARD_SKIP=1 git commit|push` 会跳过检查，**仅限排障**，且必须在提交信息/PR 里说明
- `git commit --no-verify` 同样绕过钩子，禁止用于常规开发
- CI 的 `git-guard` job 不依赖本地钩子，绕过本地钩子仍会在 CI 失败

---

## 11. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 提交/推送没有任何检查输出 | 钩子未安装：`pnpm hooks:install`，用 `pnpm hooks:check` 确认 |
| Windows 上出现大量 CRLF 修改 | 已用 `.gitattributes` 固定策略；执行 `git add --renormalize .` 后提交一次 |
| 规则误报 | 按第 5 节在 `.gitguardignore` 精确放行 |
| 改了规则想验证 | `pnpm git:self-test`，再 `pnpm git:check` |
| `node` 不存在 | 钩子会跳过并提示；安装 Node.js ≥ 20 后重新提交 |
