/** Shared credential/URL rules for public observations and storage backstops. */
export function redactSensitiveText(input: string): { text: string; redacted: boolean } {
  if (typeof input !== 'string') throw new TypeError('Sensitive text must be a string.');
  let redacted = false;
  const text = input
    .replace(
      /(\b(?:proxy-)?authorization\b(?:["']?\s*[:=]\s*|\s+))(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*))/gi,
      (
        match,
        prefix: string,
        double: string | undefined,
        single: string | undefined,
        rest: string | undefined,
      ) => {
        if ((double ?? single ?? rest ?? '').trim() === '[withheld]') return match;
        redacted = true;
        return prefix + '[withheld]';
      },
    )
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, (_match, scheme: string) => {
      redacted = true;
      return scheme + ' [withheld]';
    })
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, (value) => {
      try {
        const url = new URL(value);
        if (
          !url.username &&
          !url.password &&
          (!url.search || url.search === '?withheld') &&
          !url.hash
        )
          return value;
        redacted = true;
        url.username = '';
        url.password = '';
        url.search = url.search ? '?withheld' : '';
        url.hash = '';
        return url.href;
      } catch {
        redacted = true;
        return '[URL withheld]';
      }
    });
  return { text, redacted };
}
