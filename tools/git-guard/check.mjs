#!/usr/bin/env node
/**
 * git-guard —— 提交/推送前的「隐私 · 权限 · 密钥 · 敏感信息」检查
 *
 * 零依赖，纯 Node 实现，供 .githooks/{pre-commit,commit-msg,pre-push} 调用，
 * 也可手动运行。检查项见 docs/GIT_COMMIT_RULES.md。
 *
 * 模式：
 *   --staged                检查暂存区（pre-commit 默认）
 *   --commit-msg <file>     检查提交信息（commit-msg）
 *   --pre-push <remote> <url>  检查待推送提交/文件/远端/密钥（pre-push，stdin 为引号列表）
 *   --all                   全仓库扫描（CI / 手动巡检）
 *   --self-test             运行内置规则自检
 *   --list-rules            列出全部规则 id（用于 .gitguardignore）
 *
 * 通用参数：--json --strict --verbose --help
 * 环境变量：GIT_GUARD_SKIP=1（跳过，危险）、GIT_GUARD_STRICT=1（警告也失败）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const VERSION = '1.0.0';
const SKIP_ENV = 'GIT_GUARD_SKIP';
const STRICT_ENV = 'GIT_GUARD_STRICT';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SCAN_BYTES = 512 * 1024;
const MAX_FINDINGS_PER_FILE = 40;
const MAX_PRINT = 300;

/* ------------------------------------------------------------------ */
/* 终端输出                                                            */
/* ------------------------------------------------------------------ */

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const red = (t) => paint('31;1', t);
const yellow = (t) => paint('33;1', t);
const green = (t) => paint('32;1', t);
const cyan = (t) => paint('36;1', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

const LEVEL_LABEL = { error: red('✗ 错误'), warn: yellow('⚠ 警告') };

/* ------------------------------------------------------------------ */
/* git 调用                                                            */
/* ------------------------------------------------------------------ */

function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} 执行失败：${(res.stderr || '').trim()}`);
  }
  return res;
}

const gitOut = (args, opts = {}) => git(args, opts).stdout;
const gitOr = (args, fallback = '') => {
  const r = git(args, { allowFail: true });
  return r.status === 0 ? r.stdout : fallback;
};

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel'], { allowFail: true });
  const root = (r.status === 0 ? r.stdout : '').trim();
  return root || process.cwd();
}

/* ------------------------------------------------------------------ */
/* 规则表                                                              */
/* ------------------------------------------------------------------ */

/** 允许出现的家目录用户名（文档示例 / CI 用户） */
const ALLOWED_HOME_USERS = new Set(['me', 'example', 'user', 'runner', 'your', 'username', 'node']);

/** 允许出现的邮箱域名（RFC 2606 示例域 + GitHub 免回复地址） */
const ALLOWED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.co.uk', 'users.noreply.github.com'];

/**
 * 行级规则。
 * id      —— 规则标识（用于 .gitguardignore 的 rule: 指令）
 * level   —— error 阻断 / warn 提示
 * mask    —— 输出脱敏方式：secret 全脱敏 / partial 部分脱敏 / none 明文
 * re      —— 正则
 * test    —— 自定义判定，返回 { value } 或 null
 * skipValue —— 命中但可放行（占位符、示例值等）
 */
const LINE_RULES = [
  {
    id: 'secret/private-key',
    level: 'error',
    mask: 'secret',
    desc: '私钥内容（PRIVATE KEY 块）',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'secret/github-token',
    level: 'error',
    mask: 'secret',
    desc: 'GitHub Token（ghp_/gho_/ghu_/ghs_/ghr_/github_pat_）',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    id: 'secret/llm-api-key',
    level: 'error',
    mask: 'secret',
    desc: 'LLM API Key（OpenAI / DeepSeek / Anthropic 等 sk- 前缀）',
    re: /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'secret/aws-key',
    level: 'error',
    mask: 'secret',
    desc: 'AWS Access Key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'secret/google-api-key',
    level: 'error',
    mask: 'secret',
    desc: 'Google API Key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'secret/slack-token',
    level: 'error',
    mask: 'secret',
    desc: 'Slack Token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'secret/jwt',
    level: 'warn',
    mask: 'secret',
    desc: '疑似 JWT 令牌',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: 'secret/bearer-token',
    level: 'warn',
    mask: 'secret',
    desc: 'Bearer 令牌',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/,
    skipValue: (value) => isPlaceholder(value),
  },
  {
    id: 'secret/url-credentials',
    level: 'error',
    mask: 'secret',
    desc: 'URL 内嵌账号口令（如 postgres://user:pass@host）',
    test(line) {
      const m = line.match(/\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s/@:]{1,64}):([^\s/@]{6,})@([^\s/?#]+)/i);
      if (!m) return null;
      const password = m[3];
      if (/^(?:example|test|user|username|pass|password|secret|token|x+)$/i.test(password)) return null;
      if (isPlaceholder(password)) return null;
      return { value: password };
    },
  },
  {
    id: 'secret/env-style',
    level: 'error',
    mask: 'secret',
    desc: '.env 风格密钥赋值',
    re: /^\s*(?:export\s+)?([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*(["'`]?)([^\s"'`#]{8,})/,
    skipValue: (value) => isPlaceholder(value),
  },
  {
    id: 'secret/generic-assignment',
    level: 'error',
    mask: 'secret',
    desc: '疑似硬编码密钥 / 口令',
    test(line) {
      // 只认「引号包裹的字符串字面量」，避免把 result.client_secret、data.tenant_access_token
      // 这类表达式误判成密钥；再用字符类别熵判断是否像真实密钥。
      const m = line.match(
        /\b(api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|private[_-]?key|client[_-]?secret|app[_-]?secret|auth[_-]?token|access[_-]?token|webhook[_-]?url|session[_-]?key)\b\s*[:=]\s*(["'`])([^"'`\s]{16,})\2/i,
      );
      if (!m) return null;
      const value = m[3];
      if (isPlaceholder(value)) return null;
      if (!looksLikeSecret(value)) return null;
      return { value };
    },
  },
  {
    id: 'privacy/home-path',
    level: 'warn',
    mask: 'none',
    desc: '绝对家目录路径（可能泄露本机用户名）',
    test(line) {
      let m = line.match(/\/(?:home|Users)\/([A-Za-z0-9._-]+)/);
      if (m) return { value: m[1] };
      m = line.match(/[A-Za-z]:\\+Users\\+([A-Za-z0-9._-]+)/);
      if (m) return { value: m[1] };
      return null;
    },
    skipValue: (value, ctx) => {
      const user = String(value).toLowerCase();
      // 单/双字符用户名视为占位符（如测试里的 C:\Users\u\）
      if (user.length <= 2) return true;
      return ALLOWED_HOME_USERS.has(user) || ctx.ignore.homeUsers.has(user);
    },
  },
  {
    id: 'privacy/email',
    level: 'warn',
    mask: 'none',
    desc: '真实邮箱地址',
    test(line) {
      const m = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (!m) return null;
      const [local, domain] = m[0].split('@');
      const d = domain.toLowerCase();
      // RFC 2606 / 常见占位域名（domain.tld、host.tld 之类）
      if (/(?:^|\.)(?:tld|test|invalid|local|localhost|internal|lan|example)$/.test(d)) return null;
      if (ALLOWED_EMAIL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))) return null;
      if (/^(?:noreply|no-reply|git|npm|support|info|admin|root|mailer-daemon)$/i.test(local)) return null;
      if (isPlaceholder(m[0])) return null;
      return { value: m[0] };
    },
    skipValue: (value, ctx) => ctx.ignore.emails.includes(String(value).toLowerCase()),
  },
  {
    id: 'privacy/phone-cn',
    level: 'warn',
    mask: 'partial',
    desc: '疑似中国大陆手机号',
    test(line) {
      const m = line.match(/(?<![\w.])1[3-9]\d{9}(?![\w.])/);
      return m ? { value: m[0] } : null;
    },
  },
  {
    id: 'privacy/id-card-cn',
    level: 'warn',
    mask: 'partial',
    desc: '疑似中国大陆身份证号',
    test(line) {
      const m = line.match(/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/);
      return m ? { value: m[0] } : null;
    },
  },
  {
    id: 'privacy/private-ip',
    level: 'warn',
    mask: 'none',
    desc: '内网 IP 地址（可能暴露内网拓扑）',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
];

/**
 * 路径级规则（提交/推送的文件名检查）。
 * allow —— 命中但允许的路径（如 *.example）
 */
const PATH_RULES = [
  {
    id: 'file/dotenv',
    level: 'error',
    desc: '环境变量文件（.env 系列）',
    re: /(^|\/)\.env(\.[^/]+)?$/i,
    allow: /\.(?:example|sample|template|defaults|dist)$/i,
  },
  { id: 'file/npmrc', level: 'error', desc: 'npm 配置（通常含 Token）', re: /(^|\/)\.npmrc$/i, allow: /\.example$/i },
  {
    id: 'file/netrc',
    level: 'error',
    desc: '凭据文件（.netrc/.git-credentials 等）',
    re: /(^|\/)(?:\.netrc|_netrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials)$/i,
  },
  { id: 'file/ssh-private-key', level: 'error', desc: 'SSH 私钥文件', re: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i },
  {
    id: 'file/private-key',
    level: 'error',
    desc: '私钥 / 证书文件',
    re: /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|ppk)$/i,
    allow: /\.(?:pub|example|sample|md|txt)$/i,
  },
  { id: 'file/aws-credentials', level: 'error', desc: 'AWS 凭据文件', re: /(^|\/)\.aws\/(?:credentials|config)$/i },
  {
    id: 'file/credentials',
    level: 'error',
    desc: '凭据文件（credentials.json / secrets.yml 等）',
    re: /(^|\/)(?:credentials|secrets)\.(?:json|ya?ml|toml|ini|env|txt)$/i,
    allow: /\.(?:example|sample|template)$/i,
  },
  { id: 'file/os-junk', level: 'error', desc: '操作系统垃圾文件', re: /(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i },
  { id: 'file/node-modules', level: 'error', desc: '依赖目录（node_modules）', re: /(^|\/)node_modules\// },
  { id: 'file/backup', level: 'warn', desc: '备份 / 临时文件', re: /(^|\/)[^/]+\.(?:bak|orig|rej|swp|tmp|old)$/i },
];

/** 允许具有可执行位（100755）的路径 */
const EXEC_ALLOWED = /^(?:bin\/|\.githooks\/|tools\/.*\.mjs$|.*\.sh$)/;

/** 远程地址白名单缺省值：只允许推送到本仓库 origin（防止误推上游/他人仓库） */
function normalizeRemote(url) {
  let s = String(url || '')
    .trim()
    .toLowerCase();
  s = s.replace(/^ssh:\/\//, '').replace(/^https?:\/\//, '').replace(/^git:\/\//, '').replace(/^ftp:\/\//, '');
  s = s.replace(/^[^@/]+@/, ''); // user@host → host
  s = s.replace(/^([^/:]+):(?!\/)/, '$1/'); // scp 风格 host:path → host/path
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  return s;
}

/* ------------------------------------------------------------------ */
/* 占位符 / 脱敏                                                       */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_RE =
  /(?:x{3,}|\*{3,}|<[^>\n]{1,40}>|\$\{[^}]+\}|%[A-Z_]{2,}%|\byour[_-]|\bexample\b|\bplaceholder\b|\bdummy\b|\bfake\b|\bsample\b|\bredacted\b|\bchangeme\b|\btodo\b|\btbd\b|\bnone\b|\bnull\b|\bundefined\b|process\.env|this\.|import\.meta|window\.|0{6,}|1234567890)/i;

function isPlaceholder(value) {
  if (value == null) return true;
  const s = String(value);
  if (!s) return true;
  return PLACEHOLDER_RE.test(s);
}

/**
 * 判断一个值是否「像真实密钥」：长度 ≥ 16，且字符类别足够混合。
 * 目的：放过 `down-small-ccm_outlined`、`plain-token-secret` 这类代码里的普通字符串，
 * 同时命中 `Zx9Qw8Er7Ty6Ui5Op4As`、64 位 hex 这类真实令牌。
 */
function looksLikeSecret(value) {
  const s = String(value ?? '');
  if (s.length < 16) return false;
  let lower = false;
  let upper = false;
  let digit = false;
  let other = false;
  for (const ch of s) {
    if (ch >= 'a' && ch <= 'z') lower = true;
    else if (ch >= 'A' && ch <= 'Z') upper = true;
    else if (ch >= '0' && ch <= '9') digit = true;
    else other = true;
  }
  const classes = [lower, upper, digit, other].filter(Boolean).length;
  if (upper && digit && (lower || other)) return true;
  if (classes >= 3) return true;
  if (classes >= 2 && s.length >= 32) return true;
  return false;
}

function maskSecret(value) {
  const s = String(value ?? '');
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-2)}（${s.length} 字符，已脱敏）`;
}

function maskPartial(value) {
  const s = String(value ?? '');
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function renderValue(finding) {
  if (finding.value == null || finding.value === '') return '';
  if (finding.mask === 'secret') return maskSecret(finding.value);
  if (finding.mask === 'partial') return maskPartial(finding.value);
  return String(finding.value);
}

/* ------------------------------------------------------------------ */
/* .gitguardignore                                                     */
/* ------------------------------------------------------------------ */

function loadIgnore(root) {
  const ignore = {
    rules: new Set(),
    paths: [],
    lines: [],
    remotes: [],
    emails: [],
    homeUsers: new Set(),
    maxBytes: DEFAULT_MAX_BYTES,
    loadedFrom: [],
  };
  const candidates = [process.env.GIT_GUARD_IGNORE, path.join(root, '.gitguardignore')].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    ignore.loadedFrom.push(file);
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (!value) continue;
      switch (key) {
        case 'rule':
          ignore.rules.add(value);
          break;
        case 'path':
          ignore.paths.push(value);
          break;
        case 'line':
          ignore.lines.push(value);
          break;
        case 'remote':
          ignore.remotes.push(value);
          break;
        case 'email':
          ignore.emails.push(value.toLowerCase());
          break;
        case 'home-user':
          ignore.homeUsers.add(value.toLowerCase());
          break;
        case 'max-bytes': {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) ignore.maxBytes = n;
          break;
        }
        default:
          break;
      }
    }
  }
  return ignore;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

function pathIgnored(ctx, file) {
  const normalized = String(file).replace(/^\.\//, '');
  return ctx.ignore.paths.some((glob) => globToRegExp(glob).test(normalized));
}

/* ------------------------------------------------------------------ */
/* 上下文 / 结果收集                                                   */
/* ------------------------------------------------------------------ */

function addFinding(ctx, finding) {
  const key = `${finding.id}|${finding.file}|${finding.line ?? 0}`;
  if (ctx.seen.has(key)) return;
  const perFile = ctx.perFile.get(finding.file) || 0;
  if (perFile >= MAX_FINDINGS_PER_FILE) return;
  ctx.perFile.set(finding.file, perFile + 1);
  ctx.seen.add(key);
  ctx.findings.push(finding);
}

function createContext(opts) {
  let root = process.cwd();
  try {
    root = repoRoot();
  } catch {
    /* 不在 git 仓库内也能跑自检 */
  }
  return {
    opts,
    mode: opts.mode,
    root,
    ignore: loadIgnore(root),
    findings: [],
    seen: new Set(),
    perFile: new Map(),
    notes: [],
  };
}

function note(ctx, text) {
  ctx.notes.push(text);
  if (ctx.opts.verbose) console.error(dim(`  · ${text}`));
}

/* ------------------------------------------------------------------ */
/* 内容扫描                                                            */
/* ------------------------------------------------------------------ */

function isBinary(content) {
  const probe = content.slice(0, 8000);
  return probe.includes('\u0000');
}

function scanContent(ctx, file, content) {
  if (content == null || content === '') return;
  if (isBinary(content)) {
    note(ctx, `跳过二进制文件 ${file}`);
    return;
  }
  const text = content.length > SCAN_BYTES ? content.slice(0, SCAN_BYTES) : content;
  if (content.length > SCAN_BYTES) note(ctx, `${file} 超过扫描上限，仅检查前 ${SCAN_BYTES} 字节`);

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 8192) continue;
    if (ctx.ignore.lines.some((s) => s && line.includes(s))) continue;

    for (const rule of LINE_RULES) {
      if (ctx.ignore.rules.has(rule.id)) continue;
      let hit = null;
      if (rule.test) {
        hit = rule.test(line);
      } else {
        const m = line.match(rule.re);
        if (m) hit = { value: m[m.length - 1] || m[0] };
      }
      if (!hit) continue;
      if (rule.skipValue && rule.skipValue(hit.value, ctx)) continue;
      addFinding(ctx, {
        level: rule.level,
        id: rule.id,
        file,
        line: i + 1,
        desc: rule.desc,
        value: hit.value,
        mask: rule.mask || (rule.level === 'error' ? 'secret' : 'none'),
      });
    }
  }
}

function scanPath(ctx, file) {
  const normalized = String(file).replace(/^\.\//, '');
  for (const rule of PATH_RULES) {
    if (ctx.ignore.rules.has(rule.id)) continue;
    if (!rule.re.test(normalized)) continue;
    if (rule.allow && rule.allow.test(normalized)) continue;
    if (pathIgnored(ctx, normalized)) continue;
    addFinding(ctx, { level: rule.level, id: rule.id, file: normalized, line: 0, desc: rule.desc, mask: 'none' });
  }
}

/* ------------------------------------------------------------------ */
/* 数据源：暂存区 / 工作区 / 指定版本                                  */
/* ------------------------------------------------------------------ */

function stagedEntries() {
  const raw = gitOut(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMRD']);
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    i += 1;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[i];
      const to = tokens[i + 1];
      i += 2;
      entries.push({ status: status[0], path: to, from });
    } else {
      entries.push({ status: status[0], path: tokens[i] });
      i += 1;
    }
  }
  return entries;
}

function indexEntries() {
  const raw = gitOut(['ls-files', '-s', '-z']);
  const entries = [];
  for (const item of raw.split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) continue;
    const meta = item.slice(0, tab).split(' ');
    entries.push({ mode: meta[0], stage: meta[2], path: item.slice(tab + 1) });
  }
  return entries;
}

function readIndexBlob(file) {
  const r = git(['cat-file', '-p', `:${file}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

function indexBlobSize(file) {
  const r = git(['cat-file', '-s', `:${file}`], { allowFail: true });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function treeFiles(ref) {
  return gitOut(['ls-tree', '-r', '-z', '--name-only', ref])
    .split('\0')
    .filter((t) => t.length > 0);
}

function readRefBlob(ref, file) {
  const r = git(['cat-file', '-p', `${ref}:${file}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

function refBlobSize(ref, file) {
  const r = git(['cat-file', '-s', `${ref}:${file}`], { allowFail: true });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* 通用检查                                                            */
/* ------------------------------------------------------------------ */

function checkIdentity(ctx) {
  const email = gitOr(['config', '--get', 'user.email']).trim();
  const name = gitOr(['config', '--get', 'user.name']).trim();
  if (!email) {
    addFinding(ctx, {
      level: 'error',
      id: 'git/user-email',
      file: 'git config',
      line: 0,
      desc: '未配置 user.email，提交无法正确归属',
      mask: 'none',
    });
  }
  if (!name) {
    addFinding(ctx, {
      level: 'warn',
      id: 'git/user-name',
      file: 'git config',
      line: 0,
      desc: '未配置 user.name',
      mask: 'none',
    });
  }
}

function checkSshKeys(ctx, remoteUrl) {
  const dir = path.join(homedir(), '.ssh');
  const names = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk'];
  const existing = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    existing.push(file);
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o077) {
        addFinding(ctx, {
          level: 'error',
          id: 'key/ssh-permissions',
          file,
          line: 0,
          desc: `SSH 私钥权限过宽（${mode.toString(8)}），应为 600（chmod 600）`,
          mask: 'none',
        });
      }
    } catch {
      /* ignore */
    }
  }
  const isSsh = /^(?:[^@/]+@|ssh:\/\/)/i.test(String(remoteUrl || '').trim()) || /^[^/:]+:/.test(String(remoteUrl || ''));
  const hasKeyConfig = /(?:^|\/)\.ssh\/(?:id_|config)/.test(gitOr(['config', '--get', 'core.sshCommand']).trim());
  if (isSsh && existing.length === 0) {
    addFinding(ctx, {
      level: 'warn',
      id: 'key/ssh-missing',
      file: dir,
      line: 0,
      desc: '未找到常见 SSH 私钥，若使用 SSH 推送请先配置身份',
      mask: 'none',
    });
  }
  if (!isSsh && !hasKeyConfig && existing.length > 0) {
    note(ctx, `使用非 SSH 远端（${remoteUrl || '未知'}），SSH 私钥检查仅做权限校验`);
  }
}

function checkRemoteAllowed(ctx, remoteName, remoteUrl) {
  const origin = normalizeRemote(gitOr(['config', '--get', 'remote.origin.url']).trim());
  const target = normalizeRemote(remoteUrl);
  const extras = ctx.ignore.remotes
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (target && origin && target === origin) return;
  if (target && extras.some((re) => re.test(remoteUrl) || re.test(target))) return;

  addFinding(ctx, {
    level: 'error',
    id: 'remote/not-allowed',
    file: `remote:${remoteName || '?'}`,
    line: 0,
    desc: `推送目标不在白名单（origin=${origin || '未配置'}，目标=${target || '未知'}）`,
    value: remoteUrl,
    mask: 'none',
  });
}

function checkIgnoredStaged(ctx, files) {
  const candidates = files.filter(Boolean);
  if (!candidates.length) return;
  const r = git(['check-ignore', '--stdin', '-z'], { input: candidates.join('\0'), allowFail: true });
  if (r.status !== 0 || !r.stdout) return;
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    addFinding(ctx, {
      level: 'warn',
      id: 'file/forced-ignored',
      file,
      line: 0,
      desc: '该文件本应在 .gitignore 中忽略，却被强制加入暂存区',
      mask: 'none',
    });
  }
}

function checkStagedModes(ctx, files) {
  const wanted = new Set(files);
  for (const entry of indexEntries()) {
    if (!wanted.has(entry.path)) continue;
    const mode = parseInt(entry.mode, 8);
    if (Number.isFinite(mode) && mode & 0o002) {
      addFinding(ctx, {
        level: 'error',
        id: 'perm/world-writable',
        file: entry.path,
        line: 0,
        desc: `文件为所有人可写（权限 ${mode.toString(8)}）`,
        mask: 'none',
      });
    }
    if (entry.mode === '120000') {
      const target = readIndexBlob(entry.path) || '';
      if (target.startsWith('/') || target.includes('..')) {
        addFinding(ctx, {
          level: 'error',
          id: 'perm/symlink-escape',
          file: entry.path,
          line: 0,
          desc: `符号链接指向仓库外（${target}），存在信息泄露风险`,
          mask: 'none',
        });
      }
    }
    if (entry.mode === '100755' && !EXEC_ALLOWED.test(entry.path)) {
      addFinding(ctx, {
        level: 'warn',
        id: 'perm/unexpected-exec',
        file: entry.path,
        line: 0,
        desc: '文件带可执行位，确认是否必要',
        mask: 'none',
      });
    }
  }
}

function checkSize(ctx, file, size) {
  if (size == null) return;
  if (size > ctx.ignore.maxBytes) {
    addFinding(ctx, {
      level: 'error',
      id: 'file/too-large',
      file,
      line: 0,
      desc: `文件过大（${(size / 1024 / 1024).toFixed(1)} MiB，上限 ${(ctx.ignore.maxBytes / 1024 / 1024).toFixed(1)} MiB）`,
      mask: 'none',
    });
  }
}

/* ------------------------------------------------------------------ */
/* 各模式                                                              */
/* ------------------------------------------------------------------ */

function runStaged(ctx) {
  checkIdentity(ctx);
  const entries = stagedEntries();
  const changed = entries.filter((e) => e.status !== 'D');
  const files = changed.map((e) => e.path);

  for (const file of files) {
    scanPath(ctx, file);
    checkSize(ctx, file, indexBlobSize(file));
    scanContent(ctx, file, readIndexBlob(file));
  }
  checkStagedModes(ctx, files);
  checkIgnoredStaged(ctx, files);
  note(ctx, `已检查暂存区 ${files.length} 个文件`);
}

function runAll(ctx) {
  // CI 检出通常没有配置 user.email，全量扫描不校验提交身份（提交时由 pre-commit 校验）
  if (!process.env.CI) checkIdentity(ctx);
  const tracked = gitOut(['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = gitOut(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])];

  for (const file of files) {
    scanPath(ctx, file);
    if (file.includes('/node_modules/') || file.startsWith('node_modules/')) continue;
    let content = null;
    try {
      const full = path.join(ctx.root, file);
      if (existsSync(full) && statSync(full).isFile()) {
        const size = statSync(full).size;
        checkSize(ctx, file, size);
        content = readFileSync(full, 'utf8');
      }
    } catch {
      content = null;
    }
    if (content == null) content = readIndexBlob(file);
    scanContent(ctx, file, content);
  }
  note(ctx, `已扫描 ${tracked.length} 个已跟踪文件、${untracked.length} 个未忽略的新文件`);
}

function runCommitMsg(ctx, file) {
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    addFinding(ctx, {
      level: 'error',
      id: 'commit-msg/unreadable',
      file,
      line: 0,
      desc: '无法读取提交信息文件',
      mask: 'none',
    });
    return;
  }
  scanContent(ctx, 'commit-message', content);
  if (content.trim().length === 0) {
    addFinding(ctx, {
      level: 'error',
      id: 'commit-msg/empty',
      file: 'commit-message',
      line: 0,
      desc: '提交信息为空',
      mask: 'none',
    });
  }
}

function runPrePush(ctx, remoteName, remoteUrl) {
  const url = remoteUrl || gitOr(['remote', 'get-url', remoteName], '').trim();
  checkRemoteAllowed(ctx, remoteName, url);
  checkSshKeys(ctx, url);
  checkIdentity(ctx);

  const input = (ctx.stdin || '').trim();
  if (!input) {
    note(ctx, '没有待推送的引用');
    return;
  }

  const lines = input.split(/\r?\n/).filter(Boolean);
  let commitCount = 0;
  let fileCount = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const localRef = parts[0];
    const localSha = parts[1];
    const remoteRef = parts[2];
    const remoteSha = parts[3];
    if (!localSha || !remoteSha) continue;
    if (/^0+$/.test(localSha)) {
      note(ctx, `删除引用 ${remoteRef}`);
      continue;
    }
    const zeroLocal = /^0+$/.test(remoteSha);
    const label = `${remoteRef || localRef}`;

    let files = [];
    let messages = '';
    if (zeroLocal) {
      files = treeFiles(localSha);
      let log = git(['log', '--format=%B', localSha, '--not', `--remotes=${remoteName}`], { allowFail: true });
      if (log.status !== 0 || !log.stdout.trim()) {
        log = git(['log', '--format=%B', '-n', '50', localSha], { allowFail: true });
      }
      messages = log.stdout || '';
      const count = gitOr(['rev-list', '--count', localSha, '--not', `--remotes=${remoteName}`]).trim();
      commitCount += Number(count) || 0;
    } else {
      files = gitOut(['diff', '--name-only', '-z', remoteSha, localSha]).split('\0').filter(Boolean);
      messages = gitOr(['log', '--format=%B', `${remoteSha}..${localSha}`]);
      const count = gitOr(['rev-list', '--count', `${remoteSha}..${localSha}`]).trim();
      commitCount += Number(count) || 0;
    }

    for (const file of files) {
      scanPath(ctx, file);
      checkSize(ctx, file, refBlobSize(localSha, file));
      scanContent(ctx, file, readRefBlob(localSha, file));
    }
    fileCount += files.length;
    scanContent(ctx, `commit-message(${label})`, messages);
  }
  note(ctx, `待推送 ${commitCount} 个提交 / ${fileCount} 个文件变更`);
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

const join = (...parts) => parts.join('');

const TEXT_FIXTURES = [
  {
    name: 'OpenAI 风格 API Key',
    text: `const key = "${['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')}";`,
    expect: ['secret/llm-api-key'],
  },
  {
    name: 'GitHub Token',
    text: `token: ${['ghp', 'a'.repeat(36)].join('_')}`,
    expect: ['secret/github-token'],
  },
  {
    name: 'OPENSSH 私钥块',
    text: join('-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'),
    expect: ['secret/private-key'],
  },
  {
    name: 'AWS Access Key',
    text: join('id = ', 'AKIA', 'IOSFODNN7EXAMPLE'),
    expect: ['secret/aws-key'],
  },
  {
    name: 'URL 内嵌口令',
    text: join('postgres', '://', 'user', ':', 's3cretpass', '@', 'db.internal:5432/app'),
    expect: ['secret/url-credentials'],
  },
  {
    name: '.env 风格密钥',
    text: join('', 'FEISHU_APP_SECRET=', 'abc123def456'),
    expect: ['secret/env-style'],
  },
  {
    name: '硬编码 secret 赋值',
    text: join('const options = { ', 'clientSecret: ', '"Zx9Qw8Er7Ty6Ui5Op4As"', ' };'),
    expect: ['secret/generic-assignment'],
  },
  {
    name: '家目录绝对路径',
    text: join('cwd=', '/', 'home', '/ross/project'),
    expect: ['privacy/home-path'],
  },
  {
    name: '真实邮箱',
    text: join('contact: ', 'dev', '@', 'realcorp.cn'),
    expect: ['privacy/email'],
  },
  {
    name: '中国大陆手机号',
    text: join('phone: ', '138', '0013', '8000'),
    expect: ['privacy/phone-cn'],
  },
  {
    name: '内网 IP',
    text: join('host ', '192.168', '.3.88'),
    expect: ['privacy/private-ip'],
  },
  {
    name: '正常代码（不应命中）',
    text: join('const apiKey = ', 'process.env.API_KEY', '; const url = "https://example.com/a";'),
    expect: [],
  },
  {
    name: '示例占位值（不应命中）',
    text: join('APP_SECRET=', '${APP_SECRET}', '  # 从环境变量注入'),
    expect: [],
  },
  {
    name: '文档示例路径（不应命中）',
    text: join('"default": ', '"/Users/me/', '.lark-channel-workspaces/dsh/default"'),
    expect: [],
  },
  {
    name: '示例邮箱（不应命中）',
    text: join('mail: ', 'noreply', '@', 'example.com'),
    expect: [],
  },
  {
    name: '代码属性赋值（不应命中）',
    text: join('this.token = data.tenant_access_token;'),
    expect: [],
  },
  {
    name: '对象字段引用（不应命中）',
    text: join('secret: result.client_secret,'),
    expect: [],
  },
  {
    name: '普通字符串字段（不应命中）',
    text: join('token: ', "'down-small-ccm_outlined'"),
    expect: [],
  },
  {
    name: '占位 TLD 邮箱（不应命中）',
    text: join('see ', 'local', '@', 'domain.tld', ' in docs'),
    expect: [],
  },
  {
    name: 'Windows 占位用户名（不应命中）',
    text: String.raw`C:\Users\u\.lark-channel\launcher.cmd`,
    expect: [],
  },
];

const PATH_FIXTURES = [
  { name: '.env 应拦截', path: '.env', expect: ['file/dotenv'] },
  { name: '.env.example 应放行', path: '.env.example', expect: [] },
  { name: 'node_modules 应拦截', path: 'node_modules/react/index.js', expect: ['file/node-modules'] },
  { name: '私钥文件应拦截', path: 'certs/server.pem', expect: ['file/private-key'] },
  { name: '凭据文件应拦截', path: 'config/credentials.json', expect: ['file/credentials'] },
  { name: '系统垃圾文件应拦截', path: '.DS_Store', expect: ['file/os-junk'] },
  { name: '普通源码应放行', path: 'src/index.ts', expect: [] },
];

function collectFor(text) {
  const ctx = createContext({ mode: 'self-test', verbose: false });
  if (typeof text === 'object') scanPath(ctx, text.path);
  else scanContent(ctx, 'fixture.ts', text);
  return new Set(ctx.findings.map((f) => f.id));
}

function runSelfTest(ctx) {
  let passed = 0;
  const failures = [];
  const cases = [
    ...TEXT_FIXTURES.map((fixture) => ({ ...fixture, kind: 'text' })),
    ...PATH_FIXTURES.map((fixture) => ({ ...fixture, kind: 'path' })),
  ];

  for (const fixture of cases) {
    const ids = collectFor(fixture.kind === 'text' ? fixture.text : { path: fixture.path });
    const missing = fixture.expect.filter((id) => !ids.has(id));
    if (missing.length) {
      failures.push(`${fixture.kind === 'text' ? '文本' : '路径'}用例「${fixture.name}」未命中：${missing.join(', ')}`);
      continue;
    }
    passed += 1;
  }

  // 断言：非预期规则不应误报（含脱敏与占位符逻辑）
  const benign = collectFor(TEXT_FIXTURES.find((f) => f.name === '正常代码（不应命中）').text);
  if (benign.size > 0) failures.push(`正常代码产生误报：${[...benign].join(', ')}`);

  const masked = maskSecret(['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-'));
  if (masked.includes('abcdefghij') || !masked.includes('…')) failures.push('敏感值未正确脱敏');

  const ignoredCtx = createContext({ mode: 'self-test', verbose: false });
  ignoredCtx.ignore.rules.add('privacy/private-ip');
  scanContent(ignoredCtx, 'fixture.ts', TEXT_FIXTURES.find((f) => f.name === '内网 IP').text);
  if (ignoredCtx.findings.some((f) => f.id === 'privacy/private-ip')) failures.push('rule: 忽略指令未生效');

  const ctx2 = createContext({ mode: 'self-test', verbose: false });
  ctx2.ignore.lines.push('192.168');
  scanContent(ctx2, 'fixture.ts', TEXT_FIXTURES.find((f) => f.name === '内网 IP').text);
  if (ctx2.findings.length > 0) failures.push('line: 忽略指令未生效');

  if (failures.length === 0) {
    console.log(green(`✓ git-guard 自检通过：${passed}/${cases.length} 用例，规则与脱敏正常`));
    return 0;
  }
  console.error(red(`✗ git-guard 自检失败：${failures.length} 项`));
  for (const failure of failures) console.error(`  - ${failure}`);
  return 1;
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

const MODE_TITLE = {
  staged: '暂存区检查（pre-commit）',
  'pre-push': '推送前检查（pre-push）',
  'commit-msg': '提交信息检查（commit-msg）',
  all: '全仓库巡检',
  'self-test': '规则自检',
};

function renderFinding(finding) {
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  const value = renderValue(finding);
  return `  ${LEVEL_LABEL[finding.level]} ${dim(`[${finding.id}]`)} ${cyan(location)}${value ? dim(' — ') + finding.desc + dim('：') + value : ' — ' + finding.desc}`;
}

function report(ctx) {
  const errors = ctx.findings.filter((f) => f.level === 'error');
  const warns = ctx.findings.filter((f) => f.level === 'warn');
  const strict = ctx.opts.strict || process.env[STRICT_ENV] === '1';
  const failed = errors.length > 0 || (strict && warns.length > 0);

  if (ctx.opts.json) {
    console.log(
      JSON.stringify(
        {
          tool: 'git-guard',
          version: VERSION,
          mode: ctx.mode,
          ok: !failed,
          errors: errors.length,
          warnings: warns.length,
          findings: ctx.findings.map((f) => ({
            level: f.level,
            id: f.id,
            file: f.file,
            line: f.line ?? 0,
            desc: f.desc,
            value: f.level === 'warn' ? f.value ?? null : f.value == null ? null : '<redacted>',
          })),
        },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }

  const title = MODE_TITLE[ctx.mode] || ctx.mode;
  console.log('');
  console.log(bold(`git-guard ▸ ${title}`) + dim(`  v${VERSION}`));

  const sorted = [...ctx.findings].sort((a, b) => (a.file === b.file ? (a.line || 0) - (b.line || 0) : a.file.localeCompare(b.file)));
  for (const finding of sorted.slice(0, MAX_PRINT)) console.log(renderFinding(finding));
  if (sorted.length > MAX_PRINT) console.log(dim(`  … 其余 ${sorted.length - MAX_PRINT} 条已省略`));

  if (errors.length === 0 && warns.length === 0) {
    console.log(green('  ✓ 隐私 / 权限 / 密钥 / 敏感信息检查通过'));
  } else if (failed) {
    console.log('');
    console.log(red(`  ✗ 已阻止：${errors.length} 个错误、${warns.length} 个警告${strict ? '（strict 模式）' : ''}`));
    console.log(dim('  处理方式：删除或改为环境变量注入；确认误报可在 .gitguardignore 放行。'));
    console.log(dim(`  紧急跳过（务必谨慎）：${SKIP_ENV}=1 git commit / git push`));
  } else {
    console.log('');
    console.log(yellow(`  ⚠ 通过，但有 ${warns.length} 个警告，建议提交前处理`));
  }
  console.log('');
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { mode: 'staged', strict: false, json: false, verbose: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--staged':
        opts.mode = 'staged';
        break;
      case '--all':
        opts.mode = 'all';
        break;
      case '--pre-push':
        opts.mode = 'pre-push';
        opts.remoteName = argv[i + 1];
        opts.remoteUrl = argv[i + 2];
        i += 2;
        break;
      case '--commit-msg':
        opts.mode = 'commit-msg';
        opts.msgFile = argv[i + 1];
        i += 1;
        break;
      case '--self-test':
        opts.mode = 'self-test';
        break;
      case '--list-rules':
        opts.listRules = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`未知参数：${arg}`);
          opts.help = true;
        } else {
          positional.push(arg);
        }
    }
  }
  opts.positional = positional;
  return opts;
}

function printHelp() {
  console.log(`
git-guard v${VERSION} —— 提交 / 推送前的隐私、权限、密钥与敏感信息检查

用法：
  node tools/git-guard/check.mjs --staged                 检查暂存区（pre-commit）
  node tools/git-guard/check.mjs --commit-msg <文件>      检查提交信息（commit-msg）
  node tools/git-guard/check.mjs --pre-push <远端> <URL>  检查待推送内容（pre-push，stdin 传入引用列表）
  node tools/git-guard/check.mjs --all                    全仓库扫描（CI / 巡检）
  node tools/git-guard/check.mjs --self-test              规则自检
  node tools/git-guard/check.mjs --list-rules             列出规则 id

选项：
  --json      输出 JSON
  --strict    警告也视为失败
  --verbose   输出扫描细节

环境变量：
  GIT_GUARD_SKIP=1    跳过检查（危险，仅排障用）
  GIT_GUARD_STRICT=1  等价于 --strict
  GIT_GUARD_IGNORE=<路径>  指定额外 .gitguardignore

规则文档：docs/GIT_COMMIT_RULES.md
`);
}

function printRules() {
  console.log(bold('\n行级规则：'));
  for (const rule of LINE_RULES) console.log(`  ${rule.level === 'error' ? red('error') : yellow('warn ')}  ${cyan(rule.id.padEnd(30))} ${rule.desc}`);
  console.log(bold('\n路径规则：'));
  for (const rule of PATH_RULES) console.log(`  ${rule.level === 'error' ? red('error') : yellow('warn ')}  ${cyan(rule.id.padEnd(30))} ${rule.desc}`);
  console.log(bold('\n其他规则：'));
  for (const id of ['git/user-email', 'git/user-name', 'key/ssh-permissions', 'key/ssh-missing', 'remote/not-allowed', 'perm/world-writable', 'perm/symlink-escape', 'perm/unexpected-exec', 'file/too-large', 'file/forced-ignored', 'commit-msg/empty']) {
    console.log(`  ${cyan(id)}`);
  }
  console.log('');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.listRules) {
    printRules();
    return 0;
  }

  const ctx = createContext(opts);

  if (opts.mode === 'self-test') return runSelfTest(ctx);

  if (process.env[SKIP_ENV] === '1') {
    console.error(yellow(`⚠ git-guard：已通过 ${SKIP_ENV}=1 跳过检查`));
    return 0;
  }

  try {
    switch (opts.mode) {
      case 'staged':
        runStaged(ctx);
        break;
      case 'all':
        runAll(ctx);
        break;
      case 'commit-msg':
        if (!opts.msgFile) throw new Error('--commit-msg 需要提交信息文件路径');
        runCommitMsg(ctx, opts.msgFile);
        break;
      case 'pre-push':
        ctx.stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
        runPrePush(ctx, opts.remoteName, opts.remoteUrl);
        break;
      default:
        throw new Error(`未知模式：${opts.mode}`);
    }
  } catch (error) {
    console.error(red(`✗ git-guard 执行失败：${error.message}`));
    return 2;
  }

  return report(ctx);
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : '';
    return import.meta.url === entry;
  } catch {
    return true;
  }
})();

if (isDirectRun) {
  process.exitCode = main();
}

export { LINE_RULES, PATH_RULES, maskSecret, isPlaceholder, loadIgnore, runSelfTest };
