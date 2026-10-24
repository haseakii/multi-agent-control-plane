import { z } from 'zod';
import { parseAgentCommand, sameAgentRuntime } from './agent-quick-config';

export const onboardingDraftKey = 'control-plane-agent-onboarding-v1';
const Runtime = z
  .object({
    type: z.literal('acp-stdio'),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(128),
    cwd: z.string().max(4096).optional(),
    environmentAllowlist: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(128)
      .optional(),
  })
  .strict();
const Row = z
  .object({
    id: z.string().regex(/^agent-[a-f0-9-]{36}$/),
    name: z.string().max(256),
    runtime: Runtime.optional(),
    selected: z.boolean(),
    leader: z.boolean(),
  })
  .strict();
const Draft = z.object({ version: z.literal(1), rows: z.array(Row).max(20) }).strict();
export type OnboardingRow = z.infer<typeof Row>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function sensitiveDraftValues(values: string[]) {
  return values.some(
    (value) =>
      /(?:^|[-_\s])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|credential|authorization)(?:[=:\s]|$)/i.test(
        value,
      ) ||
      /\b(?:Bearer|Basic)\s+\S+|\bsk-[a-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY/i.test(value) ||
      /https?:\/\/[^\s]*[?@#]/i.test(value),
  );
}

function sensitiveRuntime(row: OnboardingRow) {
  return sensitiveDraftValues([
    row.runtime?.command ?? '',
    ...(row.runtime?.args ?? []),
    row.runtime?.cwd ?? '',
  ]);
}

export function writeOnboardingDraft(storage: Store, rows: OnboardingRow[]) {
  try {
    // Only editable inputs are cached. Readiness, errors and authentication stay on the server.
    const data = Draft.parse({
      version: 1,
      rows: rows.map(({ id, name, runtime, selected, leader }) => ({
        id,
        name,
        runtime,
        selected,
        leader,
      })),
    });
    if (!data.rows.length) {
      storage.removeItem(onboardingDraftKey);
      return 'empty' as const;
    }
    if (data.rows.some(sensitiveRuntime)) {
      storage.removeItem(onboardingDraftKey);
      return 'sensitive' as const;
    }
    const text = JSON.stringify(data);
    if (text.length > 262144) throw new Error('Draft too large');
    storage.setItem(onboardingDraftKey, text);
    return 'saved' as const;
  } catch {
    try {
      storage.removeItem(onboardingDraftKey);
    } catch {
      /* unavailable storage */
    }
    return 'unavailable' as const;
  }
}

export function readOnboardingDraft(storage: Store): OnboardingRow[] {
  try {
    const text = storage.getItem(onboardingDraftKey);
    if (!text || text.length > 262144) return [];
    const data = Draft.parse(JSON.parse(text));
    if (
      new Set(data.rows.map((row) => row.id)).size !== data.rows.length ||
      data.rows.some(sensitiveRuntime)
    )
      return [];
    return data.rows.map((row) => ({
      ...row,
      ...(row.runtime ? { runtime: parseAgentCommand(JSON.stringify(row.runtime)).runtime } : {}),
    }));
  } catch {
    return [];
  }
}

interface Registered {
  definition: {
    id: string;
    name: string;
    runtime: NonNullable<OnboardingRow['runtime']>;
    orchestration: { canBeBoss: boolean };
  };
  readiness: { runtime: string };
}

export function reconcileOnboardingRows<T extends Registered>(rows: OnboardingRow[], agents: T[]) {
  return rows.map((row) => {
    const saved = agents.find((agent) => agent.definition.id === row.id);
    if (saved) {
      const unchanged = row.runtime && sameAgentRuntime(row.runtime, saved.definition.runtime);
      const done = !!unchanged && saved.readiness.runtime === 'ready';
      return {
        ...row,
        name: saved.definition.name,
        leader: saved.definition.orchestration.canBeBoss,
        saved,
        done,
        message: done
          ? '已恢复：此成员已保存且连接正常。登录状态以成员卡片为准。'
          : '已恢复：成员已保存，可检查或修正入口后继续。',
      };
    }
    const duplicate =
      row.runtime &&
      agents.find((agent) => sameAgentRuntime(agent.definition.runtime, row.runtime!));
    return {
      ...row,
      done: !!duplicate,
      existing: duplicate || undefined,
      message: duplicate
        ? `已存在：${duplicate.definition.name}。保留现有设置，请在成员卡片使用。`
        : '已恢复待接入配置；确认后再连接。',
    };
  });
}
