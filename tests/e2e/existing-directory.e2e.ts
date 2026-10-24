import { expect, test, type Page } from '@playwright/test';

const rootPath = 'C:\\合成测试 专用\\' + '较长的中文目录名称 '.repeat(9) + '\\源码';
function snapshot() {
  return {
    generatedAt: '2026-10-21T00:00:00.000Z',
    projects: [] as Array<{ id: string; name: string; defaultBossAgentId?: string }>,
    agents: [
      {
        definition: {
          id: 'fixture-boss',
          name: '确定性测试 Boss',
          enabled: true,
          runtime: { command: 'fixture', args: [] },
          orchestration: { canBeBoss: true },
          controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
          capabilities: [],
        },
        readiness: { runtime: 'ready', auth: 'not_reported' },
        authMethods: [],
      },
    ],
    tasks: [] as any[],
    timeline: [],
    messages: [],
    approvals: [],
    artifacts: [],
    runners: [{ id: 'local', kind: 'local', status: 'ready' }],
    workspaces: [] as any[],
    directoryBindings: [] as any[],
  };
}
async function setup(page: Page) {
  const state = snapshot();
  await page.route('**/api/control-center', (r) => r.fulfill({ json: state }));
  return state;
}
for (const width of [1366, 1024])
  test(`B0 bound directory confirmation and canceled goal preserve draft at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await setup(page);
    let creates = 0,
      goals = 0;
    await page.route('**/api/directories/validate', (r) =>
      r.fulfill({
        json: {
          validationId: '00000000-0000-4000-8000-000000000001',
          rootPath,
          expiresAt: '2099-01-01T00:00:00Z',
          notice: 'Fixture metadata only; no real files or model.',
        },
      }),
    );
    await page.route('**/api/projects', async (r) => {
      creates++;
      expect(r.request().postDataJSON()).toEqual({
        name: '合成绑定项目',
        workspace: {
          kind: 'existing-local',
          validationId: '00000000-0000-4000-8000-000000000001',
          confirmedPath: rootPath,
        },
      });
      const project = { id: 'bound', name: '合成绑定项目', defaultBossAgentId: 'fixture-boss' };
      state.projects.push(project);
      state.workspaces.push({
        id: 'workspace',
        projectId: 'bound',
        rootPath,
        provider: 'local-directory',
        access: 'read-write',
      });
      state.directoryBindings.push({
        id: 'workspace',
        projectId: 'bound',
        rootPath,
        confirmationVersion: 'version-one',
      });
      await r.fulfill({ status: 201, json: project });
    });
    await page.route('**/api/projects/bound/goals', async (r) => {
      goals++;
      expect(r.request().postDataJSON()).toEqual({
        objective: '合成目标，不调用模型',
        workspaceConfirmation: { workspaceId: 'workspace', rootPath, version: 'version-one' },
      });
      await r.fulfill({
        status: 409,
        json: { error: 'Directory confirmation expired; recheck before execution.' },
      });
    });
    await page.goto('/');
    await page.getByLabel('Project name', { exact: true }).fill('合成绑定项目');
    await page.getByLabel('Workspace source').selectOption('existing');
    await page.getByLabel('Existing directory path').fill(rootPath);
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Validate directory', exact: true }).click();
    await expect(page.getByLabel('Actual directory path')).toHaveText(rootPath);
    await page.getByLabel('Confirm this actual directory').check();
    await page.getByRole('button', { name: 'Cancel directory confirmation' }).click();
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
    expect(creates).toBe(0);
    await page.getByRole('button', { name: 'Validate directory', exact: true }).click();
    await page.getByLabel('Confirm this actual directory').check();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByLabel('Active project')).toHaveValue('bound');
    expect(creates).toBe(1);
    await page.getByLabel('Goal objective').fill('合成目标，不调用模型');
    const submit = page.getByRole('button', { name: 'Submit goal', exact: true });
    await submit.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(rootPath);
    const confirm = dialog.getByRole('button', { name: 'Confirm and submit goal' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel execution' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(submit).toBeFocused();
    expect(goals).toBe(0);
    await expect(page.getByLabel('Goal objective')).toHaveValue('合成目标，不调用模型');
    await submit.click();
    await dialog.getByLabel('I understand this task may read or modify this directory').check();
    state.directoryBindings[0].confirmationVersion = 'version-two';
    await confirm.click();
    await expect(dialog.getByRole('alert')).toContainText('Directory confirmation expired');
    expect(goals).toBe(1);
    expect(state.tasks).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${process.env.CONTROL_PLANE_E2E_DATA_DIR}/b0-confirmation-${width}.png`,
      fullPage: true,
    });
  });

test('B0 invalid directory feedback and input changes never retain confirmation', async ({
  page,
}) => {
  await setup(page);
  let creates = 0,
    validations = 0;
  await page.route('**/api/projects', (r) => {
    creates++;
    return r.fulfill({ status: 500, json: { error: 'Unexpected creation' } });
  });
  await page.route('**/api/directories/validate', (r) => {
    validations++;
    return validations === 1
      ? r.fulfill({ status: 400, json: { error: 'Missing or linked directory; nothing changed.' } })
      : r.fulfill({
          json: {
            validationId: '00000000-0000-4000-8000-000000000002',
            rootPath,
            expiresAt: '2099-01-01T00:00:00Z',
            notice: 'Fixture only',
          },
        });
  });
  await page.goto('/');
  await page.getByLabel('Project name', { exact: true }).fill('未创建');
  await page.getByLabel('Workspace source').selectOption('existing');
  await page.getByLabel('Existing directory path').fill(rootPath);
  await page.getByRole('button', { name: 'Validate directory', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('nothing changed');
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Validate directory', exact: true }).click();
  await page.getByLabel('Confirm this actual directory').check();
  await page.getByLabel('Existing directory path').fill(rootPath + '-different');
  await expect(page.getByLabel('Actual directory path')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
  expect(creates).toBe(0);
});

test('B0 recovery acknowledgement is invalidated by polling a new binding version', async ({
  page,
}) => {
  const state: any = await setup(page);
  state.projects.push({ id: 'bound', name: '恢复合成项目', defaultBossAgentId: 'fixture-boss' });
  state.workspaces.push({ id: 'workspace', projectId: 'bound', rootPath });
  state.directoryBindings.push({
    id: 'workspace',
    projectId: 'bound',
    rootPath,
    confirmationVersion: 'v1',
  });
  state.tasks.push({
    id: 'recoverable',
    projectId: 'bound',
    title: '可恢复合成任务',
    objective: 'synthetic',
    state: 'failed',
    resultArtifactRefs: [],
  });
  state.assignments = [
    {
      id: 'assignment',
      taskId: 'recoverable',
      agentId: 'fixture-boss',
      attempt: 1,
      state: 'failed',
    },
  ];
  state.executionAttempts = [
    {
      id: 'attempt',
      taskId: 'recoverable',
      assignmentId: 'assignment',
      number: 1,
      state: 'interrupted',
    },
  ];
  let posts = 0;
  await page.route('**/api/tasks/recoverable/resume', async (r) => {
    posts++;
    expect(r.request().postDataJSON()).toEqual({
      workspaceConfirmation: { workspaceId: 'workspace', rootPath, version: 'v2' },
    });
    await r.fulfill({
      status: 409,
      json: { error: 'Synthetic stopped path: no execution started' },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Recover from saved context' }).click();
  const dialog = page.getByRole('dialog'),
    confirm = dialog.getByRole('button', { name: 'Create new execution attempt' });
  const ack = dialog.getByLabel('I have rechecked this workspace before recovery');
  await expect(confirm).toBeDisabled();
  await ack.check();
  await expect(confirm).toBeEnabled();
  state.directoryBindings[0].confirmationVersion = 'v2';
  await expect(ack).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  expect(posts).toBe(0);
  await ack.check();
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText('no execution started');
  expect(posts).toBe(1);
});
