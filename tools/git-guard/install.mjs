#!/usr/bin/env node
/**
 * git-guard 钩子安装器
 *
 *   node tools/git-guard/install.mjs            安装（core.hooksPath = .githooks）
 *   node tools/git-guard/install.mjs --check    只检查安装状态
 *   node tools/git-guard/install.mjs --uninstall 卸载
 *
 * 钩子文件随仓库一起版本管理，因此新克隆只需执行一次 `pnpm hooks:install`。
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const red = (t) => paint('31;1', t);
const green = (t) => paint('32;1', t);
const yellow = (t) => paint('33;1', t);
const dim = (t) => paint('2', t);

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} 执行失败：${(res.stderr || '').trim()}`);
  }
  return res;
}

function currentHooksPath() {
  return git(['config', '--local', '--get', 'core.hooksPath'], { allowFail: true }).stdout.trim();
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--uninstall') ? 'uninstall' : args.has('--check') ? 'check' : 'install';

  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']).stdout.trim();
  } catch (error) {
    console.error(red(`✗ 不在 git 仓库内：${error.message}`));
    return 2;
  }

  const hooksDir = path.join(root, '.githooks');
  const configured = currentHooksPath();
  const okHooksPath = configured === '.githooks';

  if (mode === 'check') {
    const problems = [];
    if (!okHooksPath) problems.push(`core.hooksPath = "${configured || '未设置'}"，期望 ".githooks"`);
    for (const hook of HOOKS) {
      const file = path.join(hooksDir, hook);
      if (!existsSync(file)) problems.push(`缺少钩子文件 .githooks/${hook}`);
      else if (!(statSync(file).mode & 0o100)) problems.push(`钩子不可执行：.githooks/${hook}`);
    }
    if (problems.length === 0) {
      console.log(green('✓ git-guard 钩子已安装：pre-commit / commit-msg / pre-push'));
      return 0;
    }
    console.error(red('✗ git-guard 钩子未就绪：'));
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(dim('  修复：pnpm hooks:install'));
    return 1;
  }

  if (mode === 'uninstall') {
    git(['config', '--local', '--unset', 'core.hooksPath'], { allowFail: true });
    console.log(yellow('⚠ 已卸载 git-guard 钩子（core.hooksPath 已移除）'));
    console.log(dim('  钩子文件仍保留在 .githooks/，重新安装：pnpm hooks:install'));
    return 0;
  }

  // 安装
  const missing = [];
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    if (!existsSync(file)) {
      missing.push(hook);
      continue;
    }
    chmodSync(file, 0o755);
  }
  if (missing.length > 0) {
    console.error(red(`✗ 缺少钩子文件：${missing.join(', ')}`));
    return 1;
  }

  git(['config', '--local', 'core.hooksPath', '.githooks']);
  const verified = currentHooksPath();
  if (verified !== '.githooks') {
    console.error(red(`✗ core.hooksPath 设置失败（当前为 "${verified}"）`));
    return 1;
  }

  console.log(green('✓ git-guard 钩子已安装'));
  console.log(dim(`  core.hooksPath = .githooks`));
  for (const hook of HOOKS) console.log(dim(`  - .githooks/${hook}  (755)`));
  console.log('');
  console.log(dim('  提交/推送时会自动执行：隐私 · 权限 · 密钥 · 敏感信息检查'));
  console.log(dim('  规则说明：docs/GIT_COMMIT_RULES.md    紧急跳过：GIT_GUARD_SKIP=1'));
  return 0;
}

process.exitCode = main();
