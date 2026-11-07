import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Documentation contract.
 *
 * The README is the short, bilingual entry point; the detailed runtime
 * surfaces (commands, permissions, lark-cli, profiles, …) live in the usage
 * manual `USAGE.zh.md`. These assertions keep the split honest: if a surface
 * disappears from the manual, it has to be removed from this list deliberately.
 */
describe('documentation runtime contract', () => {
  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const { all } = await readDocs();

    for (const phrase of [
      'workspaces.default',
      'start/stop/restart/status/unregister',
      '/invite user',
      '/remove user',
      '/invite group',
      '/remove group',
      '/invite all group',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(all).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('does not document trusted or allowed directory authorization', async () => {
    const { all } = await readDocs();

    for (const phrase of [
      '允许访问目录',
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'allowed directory',
      'allowed directories',
      'trusted directory',
      'safe directory',
    ]) {
      expect(all).not.toContain(phrase);
    }
  });

  it('documents access control commands instead of config-only access management', async () => {
    const { all } = await readDocs();

    expect(all).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(all).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const { all, usage } = await readDocs();

    expect(usage).toContain('云文档评论按文档权限生效');
    expect(all).not.toContain('comments.enabled');
    expect(all).not.toContain('comments.rateLimit');
    expect(all).not.toContain('/doc ws bind');
  });

  it('documents canonical permissions instead of recommending legacy sandbox config', async () => {
    const { all, usage } = await readDocs();

    expect(usage).toContain('"permissions"');
    expect(usage).toContain('"defaultAccess": "full"');
    expect(usage).toContain('"maxAccess": "full"');
    expect(usage).toContain('旧版 `sandbox`');
    expect(all).not.toContain('"sandbox"');
  });
});

async function readDocs(): Promise<{ all: string; usage: string }> {
  const [en, zh, usage] = await Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../USAGE.zh.md', import.meta.url), 'utf8'),
  ]);
  return { all: `${en}\n${zh}\n${usage}`, usage };
}
