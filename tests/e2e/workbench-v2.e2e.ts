import { snapshotForUi, openApproval, showHistory, openContext, mockTaskPanels } from './helpers';
import { expect, test, type Page } from '@playwright/test';

function fixture() {
  return {
    generatedAt: '2026-10-21T00:00:00Z',
    projects: [{ id: 'p', name: 'Implementation fixture', defaultBossAgentId: 'a' }],
    agents: [
      {
        definition: {
          id: 'a',
          name: 'Fixture Agent',
          enabled: true,
          runtime: { command: 'unused', args: [] },
          orchestration: { canBeBoss: true },
          controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
          capabilities: [],
        },
        readiness: { runtime: 'ready', auth: 'not_reported' },
        authMethods: [],
      },
    ],
    tasks: [
      {
        id: 'root',
        projectId: 'p',
        title: 'Local acceptance goal',
        objective: 'A durable parent objective.',
        state: 'running',
        resultArtifactRefs: [] as string[],
      },
      {
        id: 'review',
        projectId: 'p',
        parentTaskId: 'root',
        title: 'Review boundaries',
        objective: 'Inspect the boundary.',
        state: 'waiting_approval',
        resultArtifactRefs: [] as string[],
      },
      {
        id: 'failed',
        projectId: 'p',
        title: 'Interrupted documentation',
        objective: 'Saved input remains.',
        state: 'failed',
        resultArtifactRefs: [] as string[],
      },
      {
        id: 'done',
        projectId: 'p',
        title: 'Completed validation',
        objective: 'Saved result.',
        state: 'completed',
        resultArtifactRefs: ['report'],
      },
    ],
    assignments: [
      { id: 'assignment', taskId: 'failed', agentId: 'a', attempt: 1, state: 'failed' },
      { id: 'root-assignment', taskId: 'root', agentId: 'a', attempt: 1, state: 'running' },
      { id: 'review-assignment', taskId: 'review', agentId: 'a', attempt: 1, state: 'waiting' },
      { id: 'done-assignment', taskId: 'done', agentId: 'a', attempt: 1, state: 'completed' },
    ],
    executionAttempts: [
      {
        id: 'attempt',
        taskId: 'failed',
        assignmentId: 'assignment',
        number: 1,
        state: 'failed',
        failure: { retryable: false, code: 'EXECUTION_FAILED', message: 'Fixture failure.' },
      },
    ],
    timeline: Array.from({ length: 35 }, (_, i) => ({
      id: 'event-' + i,
      taskId: 'root',
      projectId: 'p',
      type: 'task.observed.' + i,
      occurredAt: '2026-10-21T00:00:00Z',
      actor: { id: 'a', type: 'agent' as string | undefined },
      payload: { outcome: 'succeeded' },
    })),
    messages: [
      {
        id: 'message',
        projectId: 'p',
        taskId: 'root',
        fromAgentId: 'a',
        toAgentId: 'a',
        type: 'message',
        content: 'Long fixture content /'.repeat(80),
        createdAt: '2026-10-21T00:00:00Z',
      },
    ],
    approvals: [
      {
        id: 'approval',
        projectId: 'p',
        taskId: 'review',
        requesterAgentId: 'a',
        action: 'workspace.write',
        resource: { path: 'D:/fixture/src' },
        state: 'pending',
        enforcementMode: 'cooperative',
      },
    ],
    artifacts: [
      {
        id: 'report',
        projectId: 'p',
        taskId: 'done',
        kind: 'report',
        producerAgentId: 'a',
        sizeBytes: 20,
        mimeType: 'text/plain',
      },
    ],
    runners: [],
    workspaces: [],
  };
}
async function serve(page: Page, state: ReturnType<typeof fixture>) {
  await mockTaskPanels(page);
  await page.route('**/api/control-center', (route) =>
    route.fulfill({ json: snapshotForUi(state) }),
  );
  await page.route('**/api/artifacts/report/content', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'Durable fixture result.' }),
  );
  await page.goto('/');
  await expect(page.getByLabel('当前项目')).toHaveValue('p');
  await showHistory(page);
}

test('workbench keeps tasks first, scopes records, and previews results without moving the reading position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const state = fixture();
  await serve(page, state);
  await expect(page.getByRole('heading', { name: '添加已有的 AI 成员', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.goal-overview')).toContainText('Review boundaries');
  await expect(page.locator('.goal-overview')).toContainText('执行者：Fixture Agent');
  await openContext(page);
  await expect(page.getByRole('region', { name: 'Selected task' })).toContainText('Fixture Agent');
  await page.getByRole('button', { name: 'Close context', exact: true }).click();
  await page.getByRole('button', { name: 'Open task Local acceptance goal', exact: true }).click();
  await expect(
    page.locator('.timeline strong').filter({ hasText: /^task\.observed\.0$/ }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  const before = await page.evaluate(() => scrollY);
  state.timeline.push({
    id: 'tool-new',
    projectId: 'p',
    taskId: 'root',
    type: 'fleet.tool',
    occurredAt: '2026-10-21T00:00:01Z',
    actor: { id: 'a', type: 'agent' as string | undefined },
    payload: { outcome: 'succeeded' },
  });
  await page.waitForResponse('**/api/control-center');
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(5);
  const result = page
    .locator('.task-card')
    .filter({ hasText: 'Completed validation' })
    .getByRole('button', { name: '查看结果', exact: true });
  await result.click();
  await expect(page.getByRole('region', { name: 'Result preview' })).toContainText(
    'Durable fixture result.',
  );
  await expect(page.getByRole('button', { name: '关闭结果', exact: true })).toBeFocused();
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(5);
  await page.getByRole('button', { name: '关闭结果', exact: true }).click();
  await expect(result).toBeFocused();
  await page
    .getByRole('button', { name: 'Open task Interrupted documentation', exact: true })
    .click();
  await openContext(page);
  await expect(
    page.locator('.timeline strong').filter({ hasText: /^task\.observed\.0$/ }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '从已保存进度恢复', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('task actions use server qualification, preserve errors and prevent duplicate cancellation', async ({
  page,
}) => {
  const state = fixture();
  state.executionAttempts[0]!.failure.retryable = true;
  await serve(page, state);
  await page
    .getByRole('button', { name: 'Open task Interrupted documentation', exact: true })
    .click();
  await openContext(page);
  let resumes = 0,
    cancels = 0;
  await page.route('**/api/tasks/failed/resume', async (route) => {
    resumes++;
    if (resumes === 1)
      return route.fulfill({
        status: 409,
        json: { error: 'Execution is still cleaning up. Try again explicitly.' },
      });
    state.tasks[2]!.state = 'running';
    state.assignments[0]!.attempt = 2;
    state.executionAttempts[0]!.number = 2;
    state.executionAttempts[0]!.state = 'running';
    return route.fulfill({ status: 202, json: {} });
  });
  await page.getByRole('button', { name: '从已保存进度恢复', exact: true }).click();
  await expect(page.locator('.task-action-dialog[open]')).toContainText('new execution attempt');
  await page.getByRole('button', { name: 'Create new execution attempt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cleaning up');
  await page.waitForResponse('**/api/control-center');
  expect(resumes).toBe(1);
  await page.getByRole('button', { name: 'Create new execution attempt', exact: true }).click();
  await expect(page.locator('.task-action-dialog[open]')).toHaveCount(0);
  expect(resumes).toBe(2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/tasks/failed/cancel', async (route) => {
    cancels++;
    await gate;
    state.tasks[2]!.state = 'cancelled';
    state.executionAttempts[0]!.state = 'cancelled';
    await route.fulfill({ json: state.tasks[2] });
  });
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  expect(cancels).toBe(1);
  release();
  await expect(page.locator('.task-action-dialog[open]')).toHaveCount(0);
  await expect(page.locator('.task-context-summary')).toContainText('已取消');
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '从已保存进度恢复', exact: true })).toHaveCount(0);
});

test('1024 context is explicit, errors stay visible and Escape returns to the opener', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = fixture();
  await serve(page, state);
  const opener = page.getByRole('button', { name: '结果与审批 · 1', exact: true });
  await opener.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  let approvals = 0;
  await page.route('**/api/approvals/approval/approve', (route) => {
    approvals++;
    return route.fulfill({
      status: 503,
      json: { error: 'Decision not saved. Choose explicitly again.' },
    });
  });
  await openApproval(page, page.locator('.approval-card'));
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await expect(page.getByRole('region', { name: '审批详情' }).getByRole('alert')).toContainText(
    'Decision not saved',
  );
  await page.waitForResponse('**/api/control-center');
  expect(approvals).toBe(1);
  expect(state.approvals[0]!.state).toBe('pending');
  await page
    .getByRole('region', { name: '审批详情' })
    .getByRole('button', { name: '返回审批列表' })
    .press('Escape');
  await expect(page.getByRole('region', { name: '审批详情' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close context', exact: true }).press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('new goal remains open through polling and preserves its draft after a failed submission', async ({
  page,
}) => {
  const state = fixture();
  await serve(page, state);
  await page.locator('.new-goal > summary').click();
  const objective = page.getByLabel('描述任务', { exact: true });
  await expect(objective).toBeVisible();
  await page.waitForResponse('**/api/control-center');
  await expect(objective).toBeVisible();
  await objective.fill('A new independent objective.');
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/p/goals', async (route) => {
    submissions++;
    await gate;
    await route.fulfill({ status: 503, json: { error: 'Goal not saved; draft remains.' } });
  });
  await page.getByRole('button', { name: '开始协作 →', exact: true }).click();
  await expect(page.getByRole('button', { name: '启动中…', exact: true })).toBeDisabled();
  await page
    .locator('.goal-form')
    .evaluate((form) =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  expect(submissions).toBe(1);
  release();
  await expect(page.getByRole('alert')).toContainText('Goal not saved');
  await expect(objective).toBeVisible();
  await expect(objective).toHaveValue('A new independent objective.');
});

test('artifact preview yields to approval review at 1024', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await serve(page, fixture());
  await page
    .locator('.task-card')
    .filter({ hasText: 'Completed validation' })
    .getByRole('button', { name: '查看结果', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Result preview' })).toContainText(
    'Durable fixture result.',
  );
  // A narrow preview is modal: dismiss its context first, then use the page banner.
  await page.getByRole('button', { name: 'Close context', exact: true }).press('Escape');
  await page.getByRole('button', { name: '查看待审批事项', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Result preview' })).toHaveCount(0);
  const context = page.locator('.context-dialog');
  await expect(context.getByRole('region', { name: 'Selected task' })).toContainText(
    'Review boundaries',
  );
  await openApproval(page, context.locator('.approval-card'));
  await expect(context.getByRole('button', { name: '允许一次', exact: true })).toBeVisible();
  await expect(context.getByRole('button', { name: '拒绝当前请求', exact: true })).toBeVisible();
});
test('artifact list restores its rebuilt trigger at 1366', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await serve(page, fixture());
  await openContext(page);
  const trigger = page.getByRole('button', { name: '查看产物', exact: true });
  await trigger.click();
  await expect(page.getByRole('region', { name: 'Result preview' })).toContainText(
    'Durable fixture result.',
  );
  await page.getByRole('button', { name: '关闭结果', exact: true }).click();
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('1024 left-navigation result returns focus outside the closed context modal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await serve(page, fixture());
  const trigger = page
    .locator('.task-card')
    .filter({ hasText: 'Completed validation' })
    .getByRole('button', { name: '查看结果', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Result preview' })).toContainText(
    'Durable fixture result.',
  );
  await page.getByRole('button', { name: '关闭结果', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press('Tab');
  await expect(page.getByRole('button', { name: '成员与设置', exact: true })).toBeFocused();
});

for (const width of [1366, 1024]) {
  test(`Chinese status and event details remain readable and stable at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const state = fixture();
    state.tasks[1]!.title = '审查本机任务边界与审批上下文的完整中文说明'.repeat(4);
    state.tasks[1]!.objective = '目标只在任务详情集中阅读，不在导航中重复。'.repeat(15);
    state.tasks[3]!.state = 'vendor.future.state';
    state.timeline = [
      {
        id: 'approval-event',
        projectId: 'p',
        taskId: 'review',
        type: 'approval.requested',
        occurredAt: '2026-10-21T00:00:00Z',
        actor: { id: 'a', type: 'agent' as string | undefined },
        payload: { outcome: 'succeeded' },
      },
      {
        id: 'future-event',
        projectId: 'p',
        taskId: 'review',
        type: 'vendor.unknown.event',
        occurredAt: '2026-10-21T00:00:00Z',
        actor: { id: 'a', type: 'agent' as string | undefined },
        payload: { outcome: 'succeeded' },
      },
      {
        id: 'tool-event',
        projectId: 'p',
        taskId: 'review',
        type: 'fleet.tool',
        occurredAt: '2026-10-21T00:00:00Z',
        actor: { id: 'a', type: 'agent' as string | undefined },
        payload: { outcome: 'succeeded' },
      },
      {
        id: 'denied-event',
        projectId: 'p',
        taskId: 'review',
        type: 'fleet.tool',
        occurredAt: '2026-10-21T00:00:00Z',
        actor: { id: 'a', type: 'agent' as string | undefined },
        payload: { outcome: 'denied' },
      },
    ];
    await serve(page, state);
    await expect(page.locator('.task-card[data-state="waiting_approval"] .badge')).toHaveText(
      '待审批',
    );
    await expect(page.locator('.task-card[data-state="failed"] .badge')).toHaveText('失败');
    await expect(page.locator('.task-card[data-state="vendor.future.state"] .badge')).toHaveText(
      'vendor.future.state',
    );
    await expect(page.locator('.task-objective')).toHaveCount(0);
    await expect(page.locator('.goal-overview')).toContainText(state.tasks[1]!.objective);
    await expect(
      page.locator('.timeline strong').filter({ hasText: /^等待审批决定$/ }),
    ).toBeVisible();
    await expect(
      page.locator('.timeline strong').filter({ hasText: /^vendor\.unknown\.event$/ }),
    ).toBeVisible();
    const event = page.locator('.timeline li').filter({ hasText: 'approval-event' });
    await expect(event.locator('.technical-details')).not.toHaveAttribute('open');
    await event.getByText('技术详情', { exact: true }).click();
    await expect(event.locator('dd').filter({ hasText: /^approval\.requested$/ })).toBeVisible();
    await page.getByText('工具与消息记录（1）', { exact: true }).click();
    await expect(page.locator('.routine-events')).toHaveAttribute('open');
    await expect(page.getByText('结果：已拒绝', { exact: true })).toBeVisible();
    await event.getByText('技术详情', { exact: true }).press('Tab');
    await event.getByText('技术详情', { exact: true }).click();
    await event.getByText('技术详情', { exact: true }).click();
    const before = await page.evaluate(() => scrollY);
    await page.waitForResponse('**/api/control-center');
    await expect(event.locator('.technical-details')).toHaveAttribute('open');
    await expect(page.locator('.routine-events')).toHaveAttribute('open');
    await expect(event.getByText('技术详情', { exact: true })).toBeFocused();
    expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 1024) await page.getByRole('button', { name: /^结果与审批/ }).click();
    await expect(page.locator('.approval-card .badge')).toHaveText('待决定');
    state.approvals[0]!.state = 'approved';
    await page.waitForResponse('**/api/control-center');
    await expect(page.locator('.approval-card .badge')).toHaveText('已批准');
    await expect(page.getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0);
  });
}

test('timeline preserves actor type across colliding IDs and missing types', async ({ page }) => {
  const state = fixture();
  state.agents[0]!.definition.id = 'task-engine';
  state.agents[0]!.definition.name = '测试执行 Agent';
  state.timeline = ['system', 'user', 'agent', 'vendor.actor', undefined].map((type, index) => ({
    id: `actor-${index}`,
    projectId: 'p',
    taskId: 'review',
    type: 'task.created',
    occurredAt: '2026-10-21T00:00:00Z',
    actor: { id: 'task-engine', type },
    payload: { outcome: 'succeeded' },
  }));
  await serve(page, state);
  for (const [index, label] of [
    '系统 · task-engine',
    '用户 · task-engine',
    'Agent · 测试执行 Agent',
    'vendor.actor · task-engine',
    'task-engine',
  ].entries()) {
    const event = page.locator('.timeline li').filter({ hasText: `actor-${index}` });
    await expect(event.locator('small').first()).toContainText(label);
    if (index !== 2)
      await expect(event.locator('small').first()).not.toContainText('测试执行 Agent');
    await event.getByText('技术详情', { exact: true }).click();
    await expect(event.locator('dt').filter({ hasText: /^主体类型$/ })).toBeVisible();
    await expect(event.locator('dd').filter({ hasText: /^task-engine$/ })).toBeVisible();
    await expect(event.locator('dt').filter({ hasText: /^Agent ID$/ })).toHaveCount(0);
  }
});
