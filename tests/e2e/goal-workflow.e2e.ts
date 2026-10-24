import { expect, test, type Page } from '@playwright/test';

type Project = { id: string; name: string; defaultBossAgentId?: string };
type Task = {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  state: string;
  ownerAgentId: string;
  resultArtifactRefs: string[];
};
type Approval = {
  id: string;
  projectId: string;
  taskId: string;
  requesterAgentId: string;
  action: string;
  resource: Record<string, string>;
  state: string;
  enforcementMode: string;
};
type Artifact = {
  id: string;
  projectId: string;
  producerAgentId: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
};

function fixture() {
  return {
    generatedAt: '2026-10-20T00:00:00.000Z',
    projects: [] as Project[],
    agents: [
      {
        definition: {
          id: 'boss-agent',
          name: 'Local Boss',
          enabled: true,
          runtime: { command: 'local-acp', args: [] },
          orchestration: { canBeBoss: true },
          controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
          capabilities: [{ name: 'planning', source: 'configured' }],
        },
        readiness: { runtime: 'ready', auth: 'not_reported' },
        authMethods: [],
      },
    ],
    tasks: [] as Task[],
    timeline: [],
    messages: [],
    approvals: [] as Approval[],
    artifacts: [] as Artifact[],
    runners: [{ id: 'local', kind: 'local', status: 'ready' }],
    workspaces: [],
  };
}

async function serveSnapshot(page: Page, state: ReturnType<typeof fixture>) {
  await page.route('**/api/control-center', (route) => route.fulfill({ json: state }));
}

function projectWithBoss(): Project {
  return { id: 'project-one', name: 'First project', defaultBossAgentId: 'boss-agent' };
}

function goalTask(projectId = 'project-one'): Task {
  return {
    id: 'goal-one',
    projectId,
    title: 'Review the architecture',
    objective: 'Find actionable improvements.',
    state: 'running',
    ownerAgentId: 'boss-agent',
    resultArtifactRefs: [],
  };
}

test('creates a fresh project, selects its Boss, submits once and shows a durable result', async ({
  page,
}) => {
  const state = fixture();
  await serveSnapshot(page, state);
  await page.route('**/api/projects', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ name: 'New project' });
    const project = { id: 'new-project', name: 'New project' };
    state.projects.push(project);
    await route.fulfill({ status: 201, json: project });
  });
  await page.route('**/api/projects/new-project/boss', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toEqual({ agentId: 'boss-agent' });
    state.projects[0]!.defaultBossAgentId = 'boss-agent';
    await route.fulfill({ json: state.projects[0] });
  });

  let submissions = 0;
  let releaseSubmission!: () => void;
  const submissionGate = new Promise<void>((resolve) => {
    releaseSubmission = resolve;
  });
  await page.route('**/api/projects/new-project/goals', async (route) => {
    submissions += 1;
    expect(route.request().postDataJSON()).toEqual({
      title: 'Review the architecture',
      objective: 'Find actionable improvements.',
    });
    await submissionGate;
    const task = goalTask('new-project');
    state.tasks.push(task);
    await route.fulfill({ status: 202, json: { task, assignment: {}, attempt: {} } });
  });
  await page.route('**/api/artifacts/final-answer/content', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: 'Final answer incorporates the durable worker review.',
    }),
  );

  await page.goto('/');
  await expect(page.getByText('No active project')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit goal', exact: true })).toBeDisabled();
  await page.getByLabel('Project name', { exact: true }).fill(' New project ');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByLabel('Active project')).toHaveValue('new-project');
  await page.getByLabel('Goal title (optional)').fill(' Review the architecture ');
  await page.getByLabel('Goal objective').fill(' Find actionable improvements. ');
  await expect(page.getByRole('button', { name: 'Submit goal', exact: true })).toBeDisabled();
  await page.getByLabel('Select Boss agent').selectOption('boss-agent');
  await expect(page.getByRole('button', { name: 'Submit goal', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit goal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Goal objective')).toBeDisabled();
  releaseSubmission();
  await expect(page.locator('.task-card')).toContainText('执行中');
  expect(submissions).toBe(1);
  await expect(page.getByLabel('Goal objective')).toHaveValue('');

  state.tasks[0]!.state = 'completed';
  state.tasks[0]!.resultArtifactRefs = ['final-answer'];
  state.artifacts.push({
    id: 'final-answer',
    projectId: 'new-project',
    producerAgentId: 'boss-agent',
    kind: 'report',
    mimeType: 'text/plain',
    sizeBytes: 55,
  });
  await expect(page.locator('.task-card')).toContainText('已完成');
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Result preview' });
  await expect(preview).toContainText('Final answer incorporates the durable worker review.');
  await expect(preview.getByRole('link', { name: 'Download result' })).toHaveAttribute(
    'href',
    '/api/artifacts/final-answer/content',
  );
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.task-card')).toContainText('已完成');
  expect(submissions).toBe(1);
});

test('keeps a failed goal draft and error through polling, then allows an explicit retry', async ({
  page,
}) => {
  const state = fixture();
  state.projects.push(projectWithBoss());
  await serveSnapshot(page, state);
  let submissions = 0;
  await page.route('**/api/projects/project-one/goals', async (route) => {
    submissions += 1;
    if (submissions === 1) {
      await route.fulfill({ status: 409, json: { error: 'Boss is not ready. Probe it first.' } });
      return;
    }
    const task = goalTask();
    state.tasks.push(task);
    await route.fulfill({ status: 202, json: { task } });
  });
  await page.goto('/');
  await page.getByLabel('Goal objective').fill('Find actionable improvements.');
  await page.getByRole('button', { name: 'Submit goal', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Boss is not ready. Probe it first.');
  const nextPoll = page.waitForResponse('**/api/control-center');
  await nextPoll;
  await expect(page.getByRole('alert')).toContainText('Boss is not ready. Probe it first.');
  await expect(page.getByLabel('Goal objective')).toHaveValue('Find actionable improvements.');
  expect(submissions).toBe(1);
  await page.getByRole('button', { name: 'Submit goal', exact: true }).click();
  await expect(page.locator('.task-card')).toContainText('执行中');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(submissions).toBe(2);
});

test('only decides pending approvals after the user chooses approve or reject', async ({
  page,
}) => {
  const state = fixture();
  state.projects.push(projectWithBoss());
  state.approvals.push(
    ...['write', 'network'].map((id) => ({
      id,
      projectId: 'project-one',
      taskId: 'goal-one',
      requesterAgentId: 'boss-agent',
      action: id === 'write' ? 'workspace.write' : 'network.access',
      resource: { path: id === 'write' ? '/project/src' : 'https://example.com' },
      state: 'pending',
      enforcementMode: 'enforced',
    })),
  );
  await serveSnapshot(page, state);
  const decisions: string[] = [];
  await page.route(/\/api\/approvals\/(write|network)\/(approve|reject)$/, async (route) => {
    const [id, decision] = new URL(route.request().url()).pathname.split('/').slice(-2);
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    decisions.push(`${id}:${decision}`);
    const approval = state.approvals.find((item) => item.id === id)!;
    approval.state = decision === 'approve' ? 'approved' : 'rejected';
    await route.fulfill({ json: approval });
  });
  await page.goto('/');
  const write = page.locator('.approval-card').filter({ hasText: 'workspace.write' });
  const network = page.locator('.approval-card').filter({ hasText: 'network.access' });
  await expect(write).toContainText('/project/src');
  await expect(write).toContainText('boss-agent');
  await expect(write).toContainText('enforced');
  await expect(network.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
  expect(decisions).toEqual([]);
  await write.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(write.locator('.badge')).toHaveText('已批准');
  await expect(write.getByRole('button')).toHaveCount(0);
  await network.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(network.locator('.badge')).toHaveText('已拒绝');
  await expect(network.getByRole('button')).toHaveCount(0);
  expect(decisions).toEqual(['write:approve', 'network:reject']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  expect(decisions).toEqual(['write:approve', 'network:reject']);
});

test('switches project-scoped data and closes an old project result', async ({ page }) => {
  const state = fixture();
  state.projects.push(projectWithBoss(), { id: 'project-two', name: 'Second project' });
  state.tasks.push({
    ...goalTask(),
    state: 'completed',
    resultArtifactRefs: ['first-result'],
  });
  state.artifacts.push({
    id: 'first-result',
    projectId: 'project-one',
    producerAgentId: 'boss-agent',
    kind: 'report',
    mimeType: 'text/plain',
    sizeBytes: 12,
  });
  await serveSnapshot(page, state);
  await page.route('**/api/artifacts/first-result/content', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'First result' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Result preview' })).toContainText('First result');
  await page.getByLabel('Active project').selectOption('project-two');
  await expect(page.getByRole('region', { name: 'Result preview' })).toHaveCount(0);
  await expect(page.locator('.task-card')).toHaveCount(0);
  await expect(page.getByText('No tasks in this project yet.')).toBeVisible();
  await expect(page.getByText('No artifacts in this project yet.')).toBeVisible();
  await expect(page.getByLabel('Select Boss agent')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Submit goal', exact: true })).toBeDisabled();
  await page.getByLabel('Active project').selectOption('project-one');
  await expect(page.locator('.task-card')).toContainText('Review the architecture');
  await expect(page.getByRole('region', { name: 'Result preview' })).toHaveCount(0);
});
