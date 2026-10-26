import { snapshotForUi, openProjectForm, openApproval, mockTaskPanels } from './helpers';
import { expect, test } from '@playwright/test';

const initialSnapshot = {
  generatedAt: '2026-10-20T00:00:00.000Z',
  projects: [{ id: 'project-one', name: 'First project' }],
  agents: [],
  tasks: [],
  timeline: [],
  messages: [],
  approvals: [],
  artifacts: [],
  runners: [],
  workspaces: [],
};

test('a slow older poll cannot overwrite the snapshot after a new project is created', async ({
  page,
}) => {
  const state = structuredClone(initialSnapshot);
  await mockTaskPanels(page);
  await page.route('**/api/control-center', (route) =>
    route.fulfill({ json: snapshotForUi(state) }),
  );
  await page.goto('/');
  await expect(page.getByLabel('当前项目')).toHaveValue('project-one');

  const oldState = structuredClone(state);
  let releaseSlowPoll!: () => void;
  let markPollStarted!: () => void;
  const slowPoll = new Promise<void>((resolve) => {
    releaseSlowPoll = resolve;
  });
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  let requests = 0;
  await page.route('**/api/control-center', async (route) => {
    requests += 1;
    if (requests === 1) {
      markPollStarted();
      await slowPoll;
      await route.fulfill({ json: snapshotForUi(oldState) });
    } else {
      await route.fulfill({ json: snapshotForUi(state) });
    }
  });
  await page.route('**/api/projects', async (route) => {
    const project = { id: 'project-two', name: 'Second project' };
    state.projects.push(project);
    await route.fulfill({ status: 201, json: project });
  });

  await pollStarted;
  await openProjectForm(page);
  await page.getByLabel('项目名称', { exact: true }).fill('Second project');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByLabel('当前项目')).toHaveValue('project-two');
  const staleResponse = page.waitForResponse('**/api/control-center');
  releaseSlowPoll();
  await staleResponse;
  await expect(page.getByLabel('当前项目')).toHaveValue('project-two');
  await expect(page.getByLabel('当前项目').locator('option')).toHaveCount(3);
});

test('a failed approval stays pending until an explicit successful decision', async ({ page }) => {
  const state = {
    ...structuredClone(initialSnapshot),
    approvals: [
      {
        id: 'approval-one',
        projectId: 'project-one',
        taskId: 'task-one',
        requesterAgentId: 'agent-one',
        action: 'workspace.write',
        resource: { path: '/project/file.txt' },
        state: 'pending',
        enforcementMode: 'cooperative',
      },
    ],
  };
  await mockTaskPanels(page);
  await page.route('**/api/control-center', (route) =>
    route.fulfill({ json: snapshotForUi(state) }),
  );
  let attempts = 0;
  await page.route('**/api/approvals/approval-one/approve', async (route) => {
    attempts += 1;
    await route.fulfill({ status: 503, json: { error: 'Approval could not be saved.' } });
  });
  await page.route('**/api/approvals/approval-one/reject', async (route) => {
    attempts += 1;
    state.approvals[0]!.state = 'rejected';
    await route.fulfill({ json: state.approvals[0] });
  });
  await page.goto('/');
  const approval = page.locator('.approval-card');
  const review = await openApproval(page, approval);
  await review.getByRole('button', { name: '允许一次', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('Approval could not be saved.');
  await expect(review).toContainText('待决定');
  await expect(review.getByRole('button', { name: '允许一次', exact: true })).toBeEnabled();
  await page.waitForResponse('**/api/control-center');
  expect(attempts).toBe(1);
  await review.getByRole('button', { name: '拒绝当前请求', exact: true }).click();
  await review.getByRole('button', { name: '返回审批列表' }).click();
  await expect(approval.locator('.badge')).toContainText('已拒绝');
  await expect(approval.getByRole('button', { name: '查看审批详情' })).toBeEnabled();
  expect(attempts).toBe(2);
});

test('keeps project and approval controls usable on a narrow screen', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const state = {
    ...structuredClone(initialSnapshot),
    approvals: [
      {
        id: 'approval-one',
        projectId: 'project-one',
        requesterAgentId: 'agent-one',
        action: 'workspace.write',
        resource: { path: `/project/${'long-directory-name/'.repeat(10)}file.txt` },
        state: 'pending',
        enforcementMode: 'enforced',
      },
    ],
  };
  await mockTaskPanels(page);
  await page.route('**/api/control-center', (route) =>
    route.fulfill({ json: snapshotForUi(state) }),
  );
  await page.goto('/');
  await expect(page.getByLabel('当前项目')).toHaveValue('project-one');
  await page.getByRole('button', { name: /结果与审批/ }).click();
  await openApproval(page, page.locator('.approval-card'));
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('mobile-control-center.png'), fullPage: true });
});
