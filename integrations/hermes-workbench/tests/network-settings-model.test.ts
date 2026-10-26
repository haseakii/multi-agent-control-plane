import { expect, it } from 'vitest';
import {
  draftChoice,
  networkPayload,
  networkSummary,
  proxyAddress,
  sameNetworkDraft,
  networkTestSignature,
} from '../src/network-settings-model';
it('normalizes the supplied local proxy, keeps individual routes independent, and rejects credential URLs', () => {
  expect(proxyAddress('127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
  expect(networkTestSignature({ mode: 'proxy', proxyUrl: '127.0.0.1:7897', bypass: [] })).toBe(
    networkTestSignature({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7897', bypass: [] }),
  );
  expect(proxyAddress('socks5://127.0.0.1:7897')).toBeNull();
  expect(proxyAddress('http://user:password@localhost:7897')).toBeNull();
  const draft = {
    global: { mode: 'proxy' as const, proxyUrl: '127.0.0.1:7897', bypass: [] },
    members: {
      a: { mode: 'inherit' as const, bypass: [] },
      b: { mode: 'direct' as const, bypass: [] },
    },
  };
  expect(networkSummary(draftChoice(draft, 'a'))).toBe('http://127.0.0.1:7897');
  expect(networkSummary(draftChoice(draft, 'b'))).toBe('直接连接');
  expect(networkPayload(draft).global.proxyUrl).toBe('http://127.0.0.1:7897');
  expect(draft.global.proxyUrl).toBe('127.0.0.1:7897');
  expect(
    sameNetworkDraft(draft, {
      ...draft,
      global: { ...draft.global, proxyUrl: 'http://127.0.0.1:7897/' },
      members: { b: draft.members.b, a: draft.members.a },
    }),
  ).toBe(true);
  expect(
    sameNetworkDraft(draft, {
      ...draft,
      global: { ...draft.global, proxyUrl: 'http://127.0.0.1:7888' },
    }),
  ).toBe(false);
  expect(() =>
    networkPayload({ ...draft, global: { ...draft.global, proxyUrl: 'bad address' } }),
  ).toThrow();
});
