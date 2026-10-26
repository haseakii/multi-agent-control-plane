import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const Manifest = z.object({
  name: z.string().max(214),
  version: z.string().max(128).optional(),
  bin: z.union([
    z.string().max(4096),
    z
      .record(z.string().max(128), z.string().max(4096))
      .refine((value) => Object.keys(value).length <= 16),
  ]),
});

/** Registry package names only: never URLs, aliases, paths, or install commands. */
export function installedPackageName(spec?: string): string | undefined {
  return spec?.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[^\s/\\:]+)?$/)?.[1];
}

/** Read one known package manifest and its bin metadata. No scripts or package managers run. */
export function installedPackageEntries(root: string, expectedName: string, managed = false) {
  let fd: number | undefined;
  try {
    const canonical = realpathSync(root);
    if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(canonical)) return [];
    const manifestPath = realpathSync(resolve(canonical, 'package.json'));
    if (dirname(manifestPath) !== canonical) return [];
    fd = openSync(manifestPath, 'r');
    if (!fstatSync(fd).isFile()) return [];
    const bytes = Buffer.alloc(131_073);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 131_072) return [];
    const manifest = Manifest.parse(JSON.parse(bytes.subarray(0, count).toString('utf8')));
    if (manifest.name !== expectedName) return [];
    const preferred =
      typeof manifest.bin === 'object' ? manifest.bin[expectedName.split('/').at(-1)!] : undefined;
    const bins =
      typeof manifest.bin === 'string'
        ? [manifest.bin]
        : managed && preferred
          ? [preferred]
          : Object.values(manifest.bin);
    return [...new Set(bins)].flatMap((bin) => {
      try {
        if (!bin || isAbsolute(bin) || /^[a-z]:/i.test(bin) || /[\x00-\x1f]/.test(bin)) return [];
        // Resolve links before checking containment; installed pnpm package roots may be links.
        const script = realpathSync(resolve(canonical, bin));
        const rel = relative(canonical, script);
        if (
          !rel ||
          rel === '..' ||
          rel.startsWith('..' + sep) ||
          isAbsolute(rel) ||
          !(/\.(?:c|m)?js$/i.test(script) || (managed && /\.exe$/i.test(script))) ||
          !statSync(script).isFile()
        )
          return [];
        return [
          {
            script,
            packageName: manifest.name,
            ...(manifest.version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)
              ? { packageVersion: manifest.version }
              : {}),
          },
        ];
      } catch {
        // A missing optional binary must not hide another usable entry in the same package.
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
