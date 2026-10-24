import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

type FrontendPackage = {
  name: string;
  version: string;
  license: string;
  repository?: { url?: string } | string;
};
type LicenseSource = { text: string; source: string; license: string };
type LicenseResolver = (manifest: FrontendPackage) => LicenseSource | undefined;

export function collectFrontendLicenses(moduleIds: string[], resolveMissing?: LicenseResolver) {
  const missing = new Set<string>();
  const packages = new Map<
    string,
    {
      name: string;
      version: string;
      license: string;
      text: string;
      file: string;
      sha256: string;
      source?: string;
    }
  >();
  for (const id of moduleIds) {
    const file = id.replace(/^\0/, '').split('?')[0]!;
    if (!isAbsolute(file) || !existsSync(file) || !file.split(/[\\/]/).includes('node_modules'))
      continue;
    let directory = dirname(realpathSync(file));
    // Some libraries include type-only package.json files in subdirectories.
    // Keep walking to the named, versioned package that owns the license.
    while (true) {
      const manifestPath = join(directory, 'package.json');
      if (existsSync(manifestPath)) {
        const candidate = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof candidate.name === 'string' && typeof candidate.version === 'string') break;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate frontend package for ${file}`);
      directory = parent;
    }
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as FrontendPackage;
    const key = `${manifest.name}@${manifest.version}`;
    const licenses = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^licen[cs]e(?:$|[._-])/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const supplement = licenses.length ? undefined : resolveMissing?.(manifest);
    if (!licenses.length && !supplement) {
      const repository =
        typeof manifest.repository === 'string'
          ? manifest.repository
          : (manifest.repository?.url ?? 'no repository');
      missing.add(`${key} (${manifest.license}; ${repository})`);
      continue;
    }
    if (
      supplement &&
      (supplement.license !== manifest.license ||
        !supplement.source.trim() ||
        !supplement.text.trim())
    )
      throw new Error(`Invalid supplemental frontend license: ${key}`);
    const texts = licenses.map((name) => {
      const text = readFileSync(join(directory, name), 'utf8');
      if (!text.trim()) throw new Error(`Empty frontend license: ${key} (${name})`);
      return licenses.length === 1 ? text : `${name}\n\n${text}`;
    });
    const text = supplement?.text ?? texts.join('\n\n========================================\n\n');
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      text,
      file: `licenses/${manifest.name.replace(/[^a-zA-Z0-9.-]/g, '_')}-${manifest.version}-LICENSE.txt`,
      sha256: createHash('sha256').update(text).digest('hex'),
      ...(supplement ? { source: supplement.source } : {}),
    });
  }
  if (missing.size)
    throw new Error(`Missing full frontend license:\n${[...missing].sort().join('\n')}`);
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function frontendLicenseNotices(resolveMissing?: LicenseResolver): Plugin {
  let finalize: ((directory: string) => void) | undefined;
  return {
    name: 'frontend-full-license-notices',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((value) => value.type === 'chunk');
      const licenses = collectFrontendLicenses(
        chunks.flatMap((chunk) => Object.keys(chunk.modules)),
        resolveMissing,
      );
      for (const required of ['react', 'react-dom', 'scheduler'])
        if (!licenses.some((item) => item.name === required))
          throw new Error(
            `Expected bundled frontend package missing from license inventory: ${required}`,
          );
      for (const item of licenses)
        this.emitFile({ type: 'asset', fileName: item.file, source: item.text });
      const notices = licenses
        .map(
          (item) =>
            `${item.name} ${item.version} (${item.license})\nFull text: ${item.file}\n\n${item.text}`,
        )
        .join('\n\n========================================\n\n');
      const manifest = {
        version: 1,
        notices: {
          file: 'THIRD-PARTY-NOTICES.txt',
          sha256: createHash('sha256').update(notices).digest('hex'),
        },
        bundles: chunks.map((chunk) => ({
          file: chunk.fileName,
          sha256: createHash('sha256').update(chunk.code).digest('hex'),
        })),
        dependencies: licenses.map(({ text: _text, ...item }) => item),
      };
      // Vite can still rewrite dynamic imports after generateBundle. Seal the
      // inventory against final written bytes, so the release gate verifies the
      // actual files it will copy rather than an intermediate chunk representation.
      finalize = (directory) => {
        const root = resolve(directory);
        for (const chunk of manifest.bundles) {
          const file = resolve(root, chunk.file);
          const local = relative(root, file);
          if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
            throw new Error('Frontend output escapes its build directory.');
          chunk.sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
        }
        writeFileSync(join(root, 'frontend-dependencies.json'), JSON.stringify(manifest, null, 2));
      };
      this.emitFile({
        type: 'asset',
        fileName: 'frontend-dependencies.json',
        source: JSON.stringify(manifest, null, 2),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-NOTICES.txt',
        source: notices,
      });
    },
    writeBundle(options) {
      if (!options.dir || !finalize)
        throw new Error('Frontend inventory requires a directory build.');
      finalize(options.dir);
    },
  };
}
