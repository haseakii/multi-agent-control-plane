const secretOutputPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactPotentialSecrets(value: string): string {
  return secretOutputPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED_SECRET]'),
    value,
  );
}
