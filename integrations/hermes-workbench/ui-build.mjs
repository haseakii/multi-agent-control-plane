import fs from 'node:fs';
import path from 'node:path';

export function uiBuildId(base) {
  try {
    const provenance = JSON.parse(
      fs.readFileSync(path.join(base, 'build-provenance.json'), 'utf8'),
    );
    return typeof provenance.builtAt === 'string' ? provenance.builtAt : undefined;
  } catch {
    return undefined;
  }
}
