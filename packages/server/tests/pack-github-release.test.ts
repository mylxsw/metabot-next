import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'pack-github-release.sh');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-github-release-test-'));
const TARBALL = path.join(OUT_DIR, 'metabot-runtime.tgz');
const INSTALLER = path.join(OUT_DIR, 'install.sh');
const CHECKSUMS = path.join(OUT_DIR, 'SHA256SUMS');

beforeAll(() => {
  execFileSync('bash', [SCRIPT], {
    env: { ...process.env, METABOT_GITHUB_RELEASE_OUTPUT_DIR: OUT_DIR },
    stdio: 'pipe',
  });
}, 60_000);

afterAll(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

describe('GitHub release package', () => {
  it('writes the stable public release asset layout', () => {
    expect(fs.statSync(TARBALL).size).toBeGreaterThan(1024);
    expect(fs.statSync(INSTALLER).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(CHECKSUMS, 'utf-8')).toMatch(/^[a-f0-9]{64}[ ]{2}metabot-runtime\.tgz\n$/);
  });

  it('points the public installer at GitHub Releases instead of localhost core', () => {
    const source = fs.readFileSync(INSTALLER, 'utf-8');
    expect(source).toContain('https://github.com/xvirobotics/metabot/releases/latest/download/metabot-runtime.tgz');
    expect(source).toContain('https://github.com/xvirobotics/metabot/releases/latest/download/SHA256SUMS');
    expect(source).toContain('Release checksum mismatch; refusing to extract');
    expect(source).not.toContain('TARBALL_URL="$CORE_URL/install/latest.tgz"');
  });

  it('ships a runtime-only manifest whose declared workspaces all exist', () => {
    const packageJson = JSON.parse(execSync(`tar xOf ${JSON.stringify(TARBALL)} package.json`, { encoding: 'utf-8' }));
    const listing = execSync(`tar tzf ${JSON.stringify(TARBALL)}`, { encoding: 'utf-8' });
    for (const workspace of packageJson.workspaces as string[]) {
      expect(listing).toContain(`${workspace}/package.json`);
    }
  });

  it('ships the complete self-hosted personal edition', () => {
    const listing = execSync(`tar tzf ${JSON.stringify(TARBALL)}`, { encoding: 'utf-8' });
    expect(listing).toContain('ecosystem.core.config.cjs');
    expect(listing).toContain('packages/server/package.json');
    expect(listing).toContain('packages/web-ui/package.json');
    expect(listing).not.toContain('packages/server/static/');
    expect(listing).not.toMatch(/(^|\n)\.?\/?web\//);

    const manifest = JSON.parse(
      execSync(`tar xOf ${JSON.stringify(TARBALL)} .metabot-package/manifest.json`, { encoding: 'utf-8' }),
    );
    expect(manifest).toMatchObject({
      package: 'metabot-personal-edition',
      version: '1.3.1',
      includesCore: true,
      includesWebUi: true,
    });

    const packageJson = JSON.parse(execSync(`tar xOf ${JSON.stringify(TARBALL)} package.json`, { encoding: 'utf-8' }));
    expect(packageJson.workspaces).toContain('packages/server');
    expect(packageJson.workspaces).toContain('packages/web-ui');
    expect(packageJson.metabotEdition).toBe('personal');
  });

  it('installs, builds, and starts local Core without printing the token', () => {
    const source = execSync(`tar xOf ${JSON.stringify(TARBALL)} install.sh`, { encoding: 'utf-8' });
    expect(source).toContain('PERSONAL_EDITION_PACKAGE=true');
    expect(source).toContain('npm run build -w @xvirobotics/metabot-core-server');
    expect(source).toContain('npm run build -w @xvirobotics/metabot-core-web-ui');
    expect(source).toContain('pm2 start ecosystem.core.config.cjs --only metabot-core');
    expect(source).toContain('Local Core token saved to $token_file (mode 600)');
    expect(source).not.toContain('echo "$METABOT_CORE_TOKEN"');
  });

  it('validates pinned versions before extraction and removes only the retired UI', () => {
    const source = fs.readFileSync(INSTALLER, 'utf-8');
    const validation = source.indexOf('METABOT_EXPECTED_PACKAGE_VERSION');
    const extraction = source.indexOf('tar xzf "$TARBALL_PATH"');
    expect(validation).toBeGreaterThan(0);
    expect(extraction).toBeGreaterThan(validation);
    expect(source).toContain('"metabot-personal-edition"');
    expect(source).toContain('"includesCore"');
    expect(source).toContain('"includesWebUi"');
    expect(source).toContain('"metabot-web"');
    expect(source).toContain('rm -rf "$METABOT_HOME/web" "$METABOT_HOME/dist/web"');
  });

  it('fails closed when public packaging is asked to embed a default env', () => {
    expect(() =>
      execFileSync('bash', [SCRIPT], {
        env: {
          ...process.env,
          METABOT_GITHUB_RELEASE_OUTPUT_DIR: OUT_DIR,
          METABOT_PACKAGE_DEFAULT_ENV_FILE: '/tmp/should-never-be-read',
        },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
