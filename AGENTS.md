# AGENTS.md

本仓库的人机协作者（含 AI 编码代理）必须遵守 [`docs/GIT_COMMIT_RULES.md`](docs/GIT_COMMIT_RULES.md)。
以下为代理执行时的硬性要求：

## 提交 / 推送前

1. 钩子会自动执行 `tools/git-guard/check.mjs`（pre-commit / commit-msg / pre-push）。
2. 若钩子未安装，先执行：`pnpm hooks:install`（无 pnpm 时用 `npm run hooks:install` 或
   `node tools/git-guard/install.mjs`）。
3. 提交前可手动全量检查：`pnpm git:check`；改动规则后必须跑 `pnpm git:self-test`。
4. 不要使用 `GIT_GUARD_SKIP=1` 或 `--no-verify` 绕过检查。检查失败时修正内容，而不是跳过。

## 禁止事项

- 禁止写入、生成、示例化任何真实密钥 / Token / 私钥 / 证书；示例一律用占位符（`your_token_here`、`${ENV_VAR}`）。
- 禁止提交 `.env`、`.npmrc`、`id_rsa`、`*.pem`、`credentials.json`、`secrets.yml` 等敏感文件。
- 禁止把内网地址、真实用户数据、个人手机号 / 邮箱 / 身份证写入代码、测试、文档或截图。
- 禁止推送到 `upstream`（只读上游），也不要对 `main` 使用 `--force`。
- 禁止为了让检查通过而放宽 `.gitguardignore` 覆盖真实敏感内容。

## 提交规范

- 提交信息使用 Conventional Commits：`<type>(<scope>): <subject>`，subject ≤ 72 字符。
- 一个提交只做一件事；大改动拆分为可 review 的小提交。
- 提交信息里不要粘贴原始日志 / 密钥 / 内网地址，必要时先脱敏。

## 分支与推送

- 默认从 `main` 拉分支：`feat/*`、`fix/*`、`chore/*`。
- 推送前跑 `pnpm ci:local`（规则检查 + 测试 + 类型检查 + 构建）。
- 只推送到 `origin`（`rovertang/im-agent-bridge`）。
