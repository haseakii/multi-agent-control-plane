import { expect, it } from 'vitest';
import { safeCatalogLink } from './agent-catalog-panel';
it('only renders explicit HTTPS license links without embedded credentials', () => {
  expect(safeCatalogLink('https://example.com/license')).toBe('https://example.com/license');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,bad',
    'http://example.com',
    'https://user:password@example.com',
    'not a URL',
    undefined,
  ])
    expect(safeCatalogLink(value)).toBeNull();
});
