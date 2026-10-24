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
  await page.route('**/api/control-center', (route) => route.fulfill({ json: state }));
  await page.goto('/');
  await expect(page.getByLabel('Active project')).toHaveValue('project-one');

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
      await route.fulfill({ json: oldState });
    } else {
      await route.fulfill({ json: state });
    }
  });
  await page.route('**/api/projects', async (route) => {
    const project = { id: 'project-two', name: 'Second project' };
    state.projects.push(project);
    await route.fulfill({ status: 201, json: project });
  });

  await pollStarted;
  await page.getByLabel('Project name', { exact: true }).fill('Second project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByLabel('Active project')).toHaveValue('project-two');
  const staleResponse = page.waitForResponse('**/api/control-center');
  releaseSlowPoll();
  await staleResponse;
  await expect(page.getByLabel('Active project')).toHaveValue('project-two');
  await expect(page.getByLabel('Active project').locator('option')).toHaveCount(3);
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
  await page.route('**/api/control-center', (route) => route.fulfill({ json: state }));
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
  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Approval could not be saved.');
  await expect(approval.locator('.badge')).toContainText('待决定');
  await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await page.waitForResponse('**/api/control-center');
  expect(attempts).toBe(1);
  await approval.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(approval.locator('.badge')).toContainText('已拒绝');
  await expect(approval.getByRole('button')).toHaveCount(0);
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
  await page.route('**/api/control-center', (route) => route.fulfill({ json: state }));
  await page.goto('/');
  await expect(page.getByLabel('Active project')).toHaveValue('project-one');
  await page.getByRole('button', { name: /Task context/ }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('mobile-control-center.png'), fullPage: true });
});
