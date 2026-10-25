import { z } from 'zod';
const Fields = { proxyUrl: z.string().optional(), bypass: z.array(z.string()).default([]) };
export const GlobalNetworkChoice = z.object({
  mode: z.enum(['unmanaged', 'direct', 'proxy']),
  ...Fields,
});
export const MemberNetworkChoice = z.object({
  mode: z.enum(['inherit', 'direct', 'proxy']),
  ...Fields,
});
export const EffectiveNetwork = z.object({
  agentId: z.string().optional(),
  source: z.enum(['global', 'member', 'existing']),
  mode: z.enum(['unmanaged', 'direct', 'proxy']),
  proxyUrl: z.string().optional(),
  bypass: z.array(z.string()),
  revision: z.number(),
  fingerprint: z.string(),
  enforcementMode: z.enum(['enforced', 'cooperative', 'unavailable']),
  boundary: z.enum(['agent-environment', 'control-plane-http']),
});
export const NetworkSettingsView = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  global: GlobalNetworkChoice,
  members: z.record(MemberNetworkChoice),
  effective: z.array(EffectiveNetwork),
  capabilities: z.object({
    proxySchemes: z.array(z.string()),
    authentication: z.boolean(),
    managedHttp: z.boolean(),
    agentBoundary: z.literal('cooperative'),
  }),
});
export const NetworkTestResult = z.object({
  result: z.enum(['passed', 'failed']),
  stage: z.string(),
  message: z.string(),
  httpStatus: z.number().optional(),
  effective: EffectiveNetwork,
  observedAt: z.string(),
  durationMs: z.number(),
  routeStatus: z.enum(['proxy-observed', 'direct', 'unconfirmed']).default('unconfirmed'),
  connection: z.object({ peerAddress: z.string(), peerPort: z.number() }).optional(),
});
export type NetworkViewData = z.infer<typeof NetworkSettingsView>;
export type GlobalChoice = z.infer<typeof GlobalNetworkChoice>;
export type MemberChoice = z.infer<typeof MemberNetworkChoice>;
export type NetworkDraft = { global: GlobalChoice; members: Record<string, MemberChoice> };
export const networkDraft = (value: NetworkViewData): NetworkDraft =>
  structuredClone({ global: value.global, members: value.members });
export function proxyAddress(raw: string) {
  try {
    const value = raw.trim();
    if (!value) return null;
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      /[\u0000-\u0020\u007f]/.test(value)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function draftChoice(draft: NetworkDraft, id?: string): GlobalChoice {
  const member = id ? draft.members[id] : undefined;
  return member && member.mode !== 'inherit' ? { ...member, mode: member.mode } : draft.global;
}
export function networkSummary(choice: GlobalChoice) {
  return choice.mode === 'unmanaged'
    ? '保留原有网络设置'
    : choice.mode === 'direct'
      ? '直接连接'
      : (proxyAddress(choice.proxyUrl ?? '') ?? '请填写代理地址');
}
export function networkPayload(draft: NetworkDraft) {
  const normalize = <T extends GlobalChoice | MemberChoice>(choice: T): T => {
    const address = proxyAddress(choice.proxyUrl ?? '');
    if (choice.mode === 'proxy' && !address)
      throw Error('请填写有效 HTTP/HTTPS 代理地址；不要包含用户名、密码、路径或查询参数。');
    return {
      ...choice,
      proxyUrl: address ?? undefined,
      bypass: choice.bypass.map((v) => v.trim()).filter(Boolean),
    };
  };
  return {
    global: normalize(draft.global),
    members: Object.fromEntries(
      Object.entries(draft.members).map(([id, choice]) => [id, normalize(choice)]),
    ),
  };
}
export function sameNetworkDraft(left: NetworkDraft, right: NetworkDraft) {
  const normalized = (value: NetworkDraft) => {
    const result = networkPayload(value);
    return JSON.stringify({
      ...result,
      members: Object.fromEntries(
        Object.entries(result.members).sort(([a], [b]) => a.localeCompare(b)),
      ),
    });
  };
  try {
    return normalized(left) === normalized(right);
  } catch {
    return false;
  }
}
export function networkTestSignature(choice: GlobalChoice) {
  const address = choice.mode === 'proxy' ? proxyAddress(choice.proxyUrl ?? '') : null;
  if (choice.mode === 'proxy' && !address) return null;
  return JSON.stringify([
    choice.mode,
    address,
    choice.bypass.map((value) => value.trim()).filter(Boolean),
  ]);
}
