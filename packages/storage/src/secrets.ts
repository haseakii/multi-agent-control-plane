const sensitiveKeyPattern =
  /^(password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret|session[_-]?cookie)$/i;

const secretValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

export class PotentialSecretError extends Error {
  constructor(path: string) {
    super(`Potential secret detected at ${path}; task/message/event payload was not persisted.`);
    this.name = 'PotentialSecretError';
  }
}

export function assertNoPotentialSecrets(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (secretValuePatterns.some((pattern) => pattern.test(value))) {
      throw new PotentialSecretError(path);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPotentialSecrets(item, `${path}[${index}]`));
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      sensitiveKeyPattern.test(key) &&
      typeof child === 'string' &&
      child.trim().length > 0
    ) {
      throw new PotentialSecretError(childPath);
    }
    assertNoPotentialSecrets(child, childPath);
  }
}
