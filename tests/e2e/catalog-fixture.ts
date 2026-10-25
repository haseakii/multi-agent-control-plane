export const catalogFixture = {
  source: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
  fetchedAt: '2026-10-25T00:00:00Z',
  stale: false,
  storage: 'file',
  error: null,
  platform: 'windows-x86_64',
  entries: [
    {
      id: 'fixture-a',
      name: '本机固定测试入口 A',
      version: '1.0.0',
      description: '<img src=x onerror=alert(1)>',
      authors: ['Synthetic fixture'],
      license: 'MIT',
      license_url: 'https://example.com/license',
      distribution: { npx: { package: 'fixture-a@1.0.0' } },
    },
    {
      id: 'fixture-b',
      name: '本机固定测试入口 B',
      version: '1.0.0',
      description: 'Synthetic metadata only',
      license_url: 'javascript:alert(1)',
      distribution: { npx: { package: 'fixture-b@1.0.0' } },
    },
  ],
};
