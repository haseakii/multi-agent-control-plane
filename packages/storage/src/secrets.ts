import { redactSensitiveText } from '@control-plane/core';

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
    super(`Potential secret detected at ${path}; sensitive payload was not persisted.`);
    this.name = 'PotentialSecretError';
  }
}

export class SensitiveApprovalReadError extends PotentialSecretError {
  readonly code = 'APPROVAL_SENSITIVE_RECORD_BLOCKED' as const;
  constructor() {
    super('$.[approval]');
    this.name = 'SensitiveApprovalReadError';
    this.message = 'This approval record is isolated and unavailable.';
  }
}

export class ApprovalRecordIntegrityError extends Error {
  readonly code = 'APPROVAL_RECORD_INVALID' as const;
  constructor() {
    super('Approval record failed validation.');
    this.name = 'ApprovalRecordIntegrityError';
  }
}

export class PermissionInspectionLimitError extends Error {
  readonly code = 'APPROVAL_INSPECTION_LIMIT_EXCEEDED' as const;
  constructor() {
    super('Approval inspection limit exceeded.');
    this.name = 'PermissionInspectionLimitError';
  }
}

/** Defense in depth for ACP approval payloads, including older unsafe rows. */
export function assertNoPermissionSecrets(value: unknown): void {
  let nodes = 0;
  const check = (item: unknown, path: string, depth: number): void => {
    if (++nodes > 5000 || depth > 16) throw new PermissionInspectionLimitError();
    if (typeof item === 'string') {
      if (
        redactSensitiveText(item).redacted ||
        secretValuePatterns.some((pattern) => pattern.test(item))
      )
        throw new PotentialSecretError(path);
      if (item.length < 16384 && /^\s*[\[{]/.test(item)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(item);
        } catch {
          return;
        }
        check(parsed, path + '.[json]', depth + 1);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => check(child, path + '[' + index + ']', depth + 1));
      return;
    }
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        const next = path + '.[field]'; // Error paths must not echo arbitrary protocol keys.
        if (
          /token|secret|password|credential|authorization|cookie|grant|api.?key|^env(?:ironment)?$|headers|^_meta$/i.test(
            key,
          ) &&
          typeof child === 'string' &&
          child.trim() &&
          child !== '[withheld]'
        )
          throw new PotentialSecretError(next);
        check(child, next, depth + 1);
      }
  };
  check(value, '$', 0);
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
    if (sensitiveKeyPattern.test(key) && typeof child === 'string' && child.trim().length > 0) {
      throw new PotentialSecretError(childPath);
    }
    assertNoPotentialSecrets(child, childPath);
  }
}
