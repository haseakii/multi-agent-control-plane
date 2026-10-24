import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { collectFrontendLicenses } from './license-notices';

it('collects only bundled packages with their complete exact license and rejects omissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-license-'));
  const pkg = join(root, 'node_modules', 'example');
  mkdirSync(pkg, { recursive: true });
  try {
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'export default 1');
    expect(() => collectFrontendLicenses([join(pkg, 'index.js')])).toThrow(
      'Missing full frontend license',
    );
    writeFileSync(join(pkg, 'LICENSE'), 'Full license text\nCopyright fixture\n');
    const notices = collectFrontendLicenses([
      join(pkg, 'index.js') + '?commonjs',
      join(pkg, 'index.js'),
      'virtual:helper',
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      name: 'example',
      version: '1.2.3',
      text: readFileSync(join(pkg, 'LICENSE'), 'utf8'),
    });
    writeFileSync(join(pkg, 'LICENSE'), '');
    expect(() => collectFrontendLicenses([join(pkg, 'index.js')])).toThrow(
      'Empty frontend license',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('retains both full license texts from underscore and hyphen named dual-license files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-dual-license-'));
  const pkg = join(root, 'node_modules', 'dual-example');
  mkdirSync(pkg, { recursive: true });
  try {
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'dual-example',
        version: '1.0.0',
        license: 'MIT OR Apache-2.0',
      }),
    );
    writeFileSync(join(pkg, 'index.js'), 'export default 1');
    writeFileSync(join(pkg, 'LICENSE_APACHE-2.0'), 'Complete Apache fixture text\n');
    writeFileSync(join(pkg, 'LICENSE-MIT'), 'Complete MIT fixture text\n');
    const result = collectFrontendLicenses([join(pkg, 'index.js')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toContain('Complete Apache fixture text\n');
    expect(result[0]?.text).toContain('Complete MIT fixture text\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('accepts a traced full-text supplement only when its declared license matches the omitted package license', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-license-source-'));
  const pkg = join(root, 'node_modules', 'omitted-license');
  mkdirSync(pkg, { recursive: true });
  try {
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'omitted-license', version: '1.0.0', license: 'MIT' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'export default 1');
    const source = {
      text: 'Complete shared project license\n',
      license: 'MIT',
      source: 'same-monorepo@1.0.0/LICENSE',
    };
    const result = collectFrontendLicenses([join(pkg, 'index.js')], () => source);
    expect(result[0]).toMatchObject(source);
    expect(() =>
      collectFrontendLicenses([join(pkg, 'index.js')], () => ({ ...source, license: 'ISC' })),
    ).toThrow('Invalid supplemental frontend license');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
