import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from './sensitive-text.js';

const encoded = Buffer.from('synthetic-user:ONLY_SYNTHETIC_BASIC_CANARY').toString('base64');
describe('shared sensitive text rules', () => {
  it.each([
    `Authorization: Basic ${encoded}`,
    `aUtHoRiZaTiOn = "bAsIc ${encoded}"`,
    `Proxy-Authorization: CustomScheme ${encoded}`,
    `Authorization: Digest username="synthetic-user", response="${encoded}"`,
    `Authorization: Basic\r\n ${encoded}`,
    `--authorization 'Basic ${encoded}'`,
    `Basic ${encoded}`,
    `Bearer ${encoded}`,
  ])('withholds complete authorization values (%#)', (text) => {
    const value = redactSensitiveText(text);
    expect(value.redacted).toBe(true);
    expect(value.text.includes(encoded)).toBe(false);
    expect(redactSensitiveText(value.text).redacted).toBe(false);
  });
  it.each(['HTTPS', 'hTtPs', 'http'])(
    'parses %s credentials, queries and fragments case-insensitively',
    (scheme) => {
      const value = redactSensitiveText(
        `${scheme}://synthetic-user:ONLY_SYNTHETIC_URL_CANARY@example.test/path?k=ONLY_SYNTHETIC_QUERY_CANARY#ONLY_SYNTHETIC_FRAGMENT_CANARY`,
      );
      expect(value.redacted).toBe(true);
      expect(value.text.includes('CANARY')).toBe(false);
      expect(redactSensitiveText(value.text).redacted).toBe(false);
    },
  );
  it('preserves normal text and plain URLs without inventing a credential', () => {
    for (const text of [
      'Read synthetic.txt',
      'HTTPS://example.test/path',
      'Authorization: [withheld]',
      '{"authorization":"[withheld]"}',
    ])
      expect(redactSensitiveText(text)).toEqual({ text, redacted: false });
  });
});
