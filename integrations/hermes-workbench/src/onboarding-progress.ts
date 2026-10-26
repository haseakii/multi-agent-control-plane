interface Entry {
  id: string;
  selected: boolean;
  runtime?: unknown;
  done?: boolean;
  error?: string;
  existing?: unknown;
  saved?: {
    definition: { enabled: boolean };
    readiness: { runtime: string; auth: string };
  };
}

/** A per-member retry is explicit and never queues unrelated entries. */
export function connectionQueue<T extends Entry>(rows: readonly T[], memberId?: string): T[] {
  return rows.filter(
    (row) =>
      row.runtime && !row.done && (memberId === undefined ? row.selected : row.id === memberId),
  );
}

export const onboardingStatusLabels = {
  ready: '可开始任务',
  login: '待确认登录',
  existing: '已有成员',
  disabled: '已停用',
  repair: '需处理',
  pending: '待检查',
} as const;
export type OnboardingStatus = keyof typeof onboardingStatusLabels;

export function onboardingStatus(row: Entry): OnboardingStatus {
  if (row.existing) return 'existing';
  if (row.error || !row.runtime) return 'repair';
  if (!row.done || !row.saved) return 'pending';
  if (!row.saved.definition.enabled) return 'disabled';
  if (row.saved.readiness.runtime !== 'ready') return 'repair';
  return ['ready', 'not_reported'].includes(row.saved.readiness.auth) ? 'ready' : 'login';
}

export function onboardingSummary(rows: readonly Entry[]) {
  const counts = new Map<OnboardingStatus, number>();
  for (const row of rows) {
    const status = onboardingStatus(row);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return (Object.keys(onboardingStatusLabels) as OnboardingStatus[])
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} 位${onboardingStatusLabels[status]}`)
    .join(' · ');
}
