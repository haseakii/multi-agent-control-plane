import { expect, type Locator, type Page } from '@playwright/test';

/** Explicit synthetic server state for UI-only tests, not live permission grants. */
export function snapshotForUi<
  T extends {
    projects: Array<{ id: string }>;
    workspaceConfigs?: unknown;
    approvals: Array<{
      id: string;
      state: string;
      action: string;
      resource: unknown;
      decisionEligibility?: unknown;
      acp?: unknown;
    }>;
  },
>(state: T) {
  const now = new Date().toISOString();
  return {
    ...state,
    workspaceConfigs:
      state.workspaceConfigs ??
      state.projects.map((project) => ({
        id: project.id,
        mode: 'task-local',
        sourceWorkspaceId: 'fixture-' + project.id,
        updatedAt: now,
      })),
    approvals: state.approvals.map((approval) => ({
      ...approval,
      decisionEligibility: approval.decisionEligibility ?? {
        canApprove: approval.state === 'pending',
        canReject: approval.state === 'pending',
        reason: approval.state === 'pending' ? 'current_complete' : 'already_decided',
        checkedAt: now,
        validForMs: 3000,
      },
      acp: approval.acp ?? {
        version: 1,
        attemptId: 'fixture-attempt',
        attemptNumber: 1,
        sessionId: 'sha256:' + 'a'.repeat(64),
        toolCallId: 'sha256:' + 'b'.repeat(64),
        requestId: '00000000-0000-4000-8000-000000000001',
        expiresAt: '2099-01-01T00:00:00Z',
        review: {
          version: 1,
          status: 'complete',
          tool: approval.action,
          action: approval.action,
          target: JSON.stringify(approval.resource),
          parameters: approval.resource,
          provenance: { rawInput: 'request' },
          presence: {},
          reasons: [],
          historyUsed: false,
          observedAt: now,
          expiresAt: '2099-01-01T00:00:00Z',
        },
      },
    })),
  };
}

export async function openProjectForm(page: Page) {
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
}

export async function openSettings(page: Page) {
  await page.getByRole('button', { name: '成员与设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的协作团队', exact: true })).toBeVisible();
}

export async function openCatalog(page: Page) {
  await openSettings(page);
  await page.getByText('查找其他支持的 Agent', { exact: true }).click();
  return page.getByRole('region', { name: 'ACP 接入目录' });
}

export async function openApproval(page: Page, card: Locator) {
  await openContext(page);
  await card.getByRole('button', { name: '查看审批详情', exact: true }).click();
  const review = page.getByRole('region', { name: '审批详情', exact: true });
  await expect(review).toBeVisible();
  return review;
}

export async function openContext(page: Page) {
  if (!(await page.locator('.context-dialog').isVisible()))
    await page.getByRole('button', { name: /^结果与审批/ }).click();
}

export async function mockTaskPanels(page: Page) {
  await page.route('**/api/tasks/*/instructions', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { instructions: [], canSubmit: false, reason: 'not_executing' } })
      : route.fallback(),
  );
  await page.route('**/api/tasks/*/workspace-reviews', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback(),
  );
}

export async function showHistory(page: Page) {
  const history = page.locator('.execution-history');
  if ((await history.count()) && (await history.getAttribute('open')) === null)
    await history.locator(':scope > summary').click();
}

export { catalogFixture } from './catalog-fixture';
