// Read-only runtime verification: GET requests, a read-only SQLite connection,
// and reads of the explicitly selected task's files. Only evidence files are written.
// Does not start Agents, resolve approvals, run Git, merge, or restart the service.
// Usage: node verify-git-messaging.mjs --task task-... [--sender agent-id]
//   [--recipient agent-id] [--leader agent-id] [--observe | --before-merge]
//   [--require-recipient-no-bridge]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const options = {
  sender: 'antigravity-acceptance',
  recipient: 'codex-collaborator',
  leader: 'codex-acceptance',
};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (['--observe', '--before-merge', '--require-recipient-no-bridge'].includes(flag))
    options[flag.slice(2)] = true;
  else if (['--task', '--sender', '--recipient', '--leader'].includes(flag)) {
    const value = process.argv[++index];
    assert.match(value ?? '', /^[a-zA-Z0-9_-]+$/, `Invalid value for ${flag}`);
    options[flag.slice(2)] = value;
  } else throw Error(`Unknown option: ${flag}`);
}
assert.ok(options.task, 'Select the exact browser-submitted task with --task task-...');
assert.ok(!(options.observe && options['before-merge']), 'Select one verification mode');
assert.equal(
  new Set([options.leader, options.sender, options.recipient]).size,
  3,
  'Use three distinct agent registrations',
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration/real-20261023');
const server = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
async function response(route) {
  const result = await fetch(server.url + route, { signal: AbortSignal.timeout(15000) });
  assert.equal(result.status, 200, route);
  return result;
}
async function json(route) {
  return (await response(route)).json();
}
const snapshot = await json('/api/control-center');
const task = snapshot.tasks.find((item) => item.id === options.task);
assert.ok(task, 'Selected task exists');
assert.equal(task.parentTaskId, undefined, 'Select the root task');
const taskIds = new Set([task.id]);
for (let changed = true; changed; ) {
  changed = false;
  for (const item of snapshot.tasks) {
    if (
      item.projectId === task.projectId &&
      taskIds.has(item.parentTaskId) &&
      !taskIds.has(item.id)
    ) {
      taskIds.add(item.id);
      changed = true;
    }
  }
}
const tasks = snapshot.tasks.filter((item) => taskIds.has(item.id));
const events = snapshot.timeline.filter(
  (item) => item.projectId === task.projectId && taskIds.has(item.taskId),
);
const messages = snapshot.messages.filter(
  (item) =>
    item.projectId === task.projectId &&
    [
      item.taskId,
      item.metadata?.senderTaskId,
      item.metadata?.recipientTaskId,
      item.metadata?.parentTaskId,
    ].some((id) => taskIds.has(id)),
);
const actor = (taskId) =>
  snapshot.assignments.filter((item) => item.taskId === taskId).at(-1)?.agentId;
const approvals = snapshot.approvals.filter(
  (item) => item.projectId === task.projectId && taskIds.has(item.taskId),
);
const directory = path.join(run, 'git-messaging', options.task);
const save = (name, evidence) => {
  fs.mkdirSync(directory, { recursive: true });
  const previousFile = path.join(directory, name);
  if (fs.existsSync(previousFile)) {
    const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
    const archive = path.join(
      directory,
      `${path.basename(name, '.json')}-${previous.checkedAt.replace(/[:.]/g, '-')}.json`,
    );
    if (!fs.existsSync(archive)) fs.writeFileSync(archive, JSON.stringify(previous, null, 2));
  }
  // Each check is an immutable point-in-time record. A later user follow-up may
  // intentionally change the source file, which must not rewrite past evidence.
  const checkpoint = path.join(
    directory,
    `${path.basename(name, '.json')}-${evidence.checkedAt.replace(/[:.]/g, '-')}.json`,
  );
  if (!fs.existsSync(checkpoint)) fs.writeFileSync(checkpoint, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(directory, name), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
};
const base = {
  checkedAt: new Date().toISOString(),
  taskId: task.id,
  projectId: task.projectId,
  url: `${server.url}/?task=${task.id}`,
  serverPid: server.pid,
  intendedAgents: { leader: options.leader, sender: options.sender, recipient: options.recipient },
  tasks: tasks.map((item) => ({
    id: item.id,
    parentTaskId: item.parentTaskId,
    agentId: actor(item.id),
    state: item.state,
    resultArtifactRefs: item.resultArtifactRefs,
  })),
  approvals: approvals.map((item) => ({
    id: item.id,
    taskId: item.taskId,
    action: item.action,
    state: item.state,
    boundary: item.boundary,
    enforcementMode: item.enforcementMode,
    decisionEligibility: item.decisionEligibility,
  })),
};
if (options.observe) {
  save('observation.json', {
    ...base,
    passed: false,
    scope: 'observation-only',
    status: tasks.some((item) => item.state === 'waiting_approval')
      ? 'waiting-for-approval'
      : tasks.some((item) => ['failed', 'blocked', 'cancelled'].includes(item.state))
        ? 'needs-attention'
        : tasks.every((item) => item.state === 'completed')
          ? 'completed-not-yet-verified'
          : 'running',
    messages: messages.map((item) => ({
      id: item.id,
      from: item.fromAgentId,
      to: item.toAgentId,
      type: item.type,
      replyTo: item.replyTo,
      taskId: item.taskId,
      metadata: item.metadata,
      artifactRefs: item.artifactRefs,
      delivery: snapshot.messageDeliveries.find((row) => row.messageId === item.id),
    })),
    relevantEvents: events
      .filter((item) =>
        ['fleet.tool', 'execution.failed', 'approval.requested', 'execution.boundary'].includes(
          item.type,
        ),
      )
      .map((item) => ({
        id: item.id,
        taskId: item.taskId,
        type: item.type,
        occurredAt: item.occurredAt,
        payload:
          item.type === 'fleet.tool'
            ? {
                toolName: item.payload.toolName,
                outcome: item.payload.outcome,
                boundary: item.payload.boundary,
              }
            : item.payload,
      })),
  });
} else {
  assert.equal(
    task.state,
    'completed',
    'Root task must finish; use --observe for an incomplete run',
  );
  assert.equal(actor(task.id), options.leader);
  const senderTasks = tasks.filter(
    (item) => item.parentTaskId === task.id && actor(item.id) === options.sender,
  );
  assert.equal(senderTasks.length, 1, 'Exactly one intended delegated worker');
  const sender = senderTasks[0];
  assert.equal(sender.state, 'completed');
  const requests = messages.filter(
    (item) =>
      item.type === 'request' &&
      item.fromAgentId === options.sender &&
      item.toAgentId === options.recipient &&
      item.metadata.senderTaskId === sender.id,
  );
  assert.equal(requests.length, 1, 'Exactly one real routed request from Worker A to Worker B');
  const request = requests[0];
  assert.ok(request.idempotencyKey, 'Worker request has a durable idempotency key');
  assert.equal(
    messages.filter(
      (item) =>
        item.fromAgentId === request.fromAgentId && item.idempotencyKey === request.idempotencyKey,
    ).length,
    1,
    'No duplicate logical request for the recorded key',
  );
  const recipient = tasks.find((item) => item.id === request.metadata.recipientTaskId);
  assert.ok(recipient);
  assert.equal(actor(recipient.id), options.recipient);
  assert.equal(recipient.parentTaskId, sender.id);
  assert.equal(recipient.state, 'completed', 'Worker B actually executed and completed');
  const senderDefinition = snapshot.agents.find(
    (item) => item.definition.id === options.sender,
  )?.definition;
  const recipientDefinition = snapshot.agents.find(
    (item) => item.definition.id === options.recipient,
  )?.definition;
  assert.equal(senderDefinition?.orchestration.canBeBoss, false);
  assert.ok(senderDefinition.controlBridge.scopes.includes('agent.messaging'));
  assert.ok(!senderDefinition.controlBridge.scopes.includes('boss.orchestration'));
  assert.equal(recipientDefinition?.orchestration.canBeBoss, false);
  assert.ok(!recipientDefinition.controlBridge.scopes.includes('boss.orchestration'));
  if (options['require-recipient-no-bridge']) {
    assert.equal(recipientDefinition.controlBridge.transport, 'none');
    assert.deepEqual(recipientDefinition.controlBridge.scopes, []);
  }
  const reply = messages.find(
    (item) =>
      item.type === 'response' &&
      item.replyTo === request.id &&
      item.fromAgentId === options.recipient &&
      item.toAgentId === options.sender,
  );
  assert.ok(reply, 'Worker B result is routed back without Boss privileges');
  assert.equal(reply.metadata.origin, 'control-plane-task-result');
  assert.equal(reply.metadata.responseTaskId, recipient.id);
  assert.ok(recipient.resultArtifactRefs.every((id) => reply.artifactRefs.includes(id)));
  const finalHandoff = messages.find(
    (item) =>
      item.type === 'response' &&
      item.taskId === sender.id &&
      item.fromAgentId === options.sender &&
      item.toAgentId === options.leader,
  );
  assert.ok(finalHandoff, 'Worker A returns its completed result to Boss');
  for (const message of [request, reply, finalHandoff])
    assert.equal(
      snapshot.messageDeliveries.find((item) => item.messageId === message.id)?.state,
      'delivered',
      `Delivered: ${message.id}`,
    );
  const tools = events.filter(
    (item) => item.type === 'fleet.tool' && item.payload.outcome === 'succeeded',
  );
  const called = (taskId, tool) =>
    tools.some((item) => item.taskId === taskId && item.payload.toolName === tool);
  assert.ok(called(task.id, 'control_discover_agents'));
  assert.ok(called(task.id, 'control_delegate_task'));
  assert.ok(
    called(sender.id, 'control_send_message'),
    'Request was initiated through Worker A Fleet bridge',
  );
  if (options['require-recipient-no-bridge'])
    assert.ok(
      !tools.some((item) => item.taskId === recipient.id),
      'Bridge-less recipient used no Fleet tools',
    );
  assert.ok(
    !tools.some(
      (item) =>
        item.taskId === recipient.id &&
        ['control_create_task', 'control_delegate_task', 'control_cancel_task'].includes(
          item.payload.toolName,
        ),
    ),
    'Recipient did not exercise Boss orchestration tools',
  );
  assert.ok(
    tools.some(
      (item) =>
        item.taskId === task.id &&
        item.payload.toolName === 'control_get_artifact' &&
        sender.resultArtifactRefs.includes(item.payload.input?.artifactId),
    ),
    'Boss read actual Worker A artifact',
  );
  assert.ok(
    tools.some(
      (item) =>
        item.taskId === sender.id &&
        item.payload.toolName === 'control_get_artifact' &&
        recipient.resultArtifactRefs.includes(item.payload.input?.artifactId),
    ),
    'Worker A read actual Worker B artifact',
  );
  for (const item of tools) {
    assert.equal(item.payload.boundary, 'fleet-gateway');
    assert.equal(item.payload.enforcementMode, 'enforced');
  }
  const participants = [task, sender, recipient];
  const require = createRequire(new URL('../../packages/storage/package.json', import.meta.url));
  const Sqlite = require('better-sqlite3');
  const database = new Sqlite(path.join(run, 'data/state.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  let conversations;
  try {
    conversations = participants.flatMap((item) =>
      database
        .prepare('SELECT payload FROM conversations WHERE task_id = ?')
        .all(item.id)
        .map((row) => JSON.parse(row.payload)),
    );
  } finally {
    database.close();
  }
  for (const item of participants) {
    const sessions = conversations.filter((row) => row.taskId === item.id);
    assert.ok(sessions.length > 0, `${item.id} has a persisted independent ACP conversation`);
    assert.ok(sessions.every((row) => row.protocol === 'acp' && row.agentId === actor(item.id)));
  }
  assert.ok(
    new Set(conversations.map((row) => row.sessionId)).size >= 3,
    'Independent ACP sessions for all three participants',
  );
  const usage = JSON.parse(fs.readFileSync(path.join(run, 'daily-prompt-usage.json'), 'utf8'));
  assert.equal(usage.limit, null);
  const sessionIds = new Set(conversations.map((row) => row.sessionId));
  const turns = usage.turns.filter((turn) => sessionIds.has(turn.sessionId));
  for (const id of [options.leader, options.sender, options.recipient])
    assert.ok(
      turns.some((turn) => turn.agentId === id),
      `Actual ACP prompt ledger for ${id}`,
    );
  const artifacts = [];
  for (const item of participants) {
    assert.ok(item.resultArtifactRefs.length > 0);
    for (const id of item.resultArtifactRefs) {
      const metadata = snapshot.artifacts.find((row) => row.id === id);
      assert.equal(metadata?.taskId, item.id);
      const bytes = Buffer.from(
        await (await response(`/api/artifacts/${encodeURIComponent(id)}/content`)).arrayBuffer(),
      );
      assert.ok(bytes.length > 0);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, metadata.sha256);
      artifacts.push({
        taskId: item.id,
        id,
        mimeType: metadata.mimeType,
        sizeBytes: bytes.length,
        sha256,
        ...(metadata.mimeType.startsWith('text/') ? { text: bytes.toString('utf8') } : {}),
      });
    }
  }
  assert.equal(
    snapshot.workspaceConfigs.find((item) => item.id === task.projectId)?.mode,
    'git-worktree',
  );
  const bindings = participants.map((item) =>
    snapshot.assignmentWorkspaces.filter((row) => row.taskId === item.id).at(-1),
  );
  assert.ok(bindings.every((binding) => binding?.mode === 'git-worktree'));
  assert.equal(
    new Set(bindings.map((binding) => binding.workspaceId)).size,
    3,
    'Each task has an independent worktree',
  );
  const workspace = snapshot.workspaces.find((item) => item.id === bindings[0].workspaceId);
  const source = snapshot.workspaces.find((item) => item.id === bindings[0].sourceWorkspaceId);
  assert.equal(workspace?.provider, 'git-worktree');
  assert.ok(source?.rootPath);
  const resultFile = path.join(workspace.rootPath, 'welcome.txt');
  const bytes = fs.readFileSync(resultFile);
  const text = bytes.toString('utf8').trim();
  assert.ok(text.length > 0, 'Actual welcome.txt exists in Boss task worktree');
  const normalized = (value) => value.replace(/\s/g, '');
  assert.ok(
    artifacts.some(
      (item) =>
        item.taskId === task.id &&
        item.text?.includes('welcome.txt') &&
        normalized(item.text).includes(normalized(text)),
    ),
    'Final reply identifies and quotes the actual delivered file',
  );
  let merge = { verified: false, reason: 'before-merge verification requested' };
  if (!options['before-merge']) {
    const reviews = await json(`/api/tasks/${encodeURIComponent(task.id)}/workspace-reviews`);
    const merged = reviews.filter((row) => row.review.state === 'merged').at(-1);
    assert.ok(merged, 'A review must be merged through the separate approval and merge UI actions');
    assert.equal(merged.approvalState, 'approved');
    const review = merged.review;
    assert.equal(review.workspaceId, workspace.id);
    assert.equal(review.sourceWorkspaceId, source.id);
    assert.ok(review.files.some((item) => item.path === 'welcome.txt'));
    const reviewEvents = events.filter((item) => item.payload?.reviewId === review.id);
    for (const type of [
      'workspace.review.prepared',
      'workspace.review.approved',
      'workspace.review.merge-started',
      'workspace.review.merged',
    ])
      assert.ok(
        reviewEvents.some((item) => item.type === type),
        type,
      );
    const approval = approvals.find((item) => item.id === review.approvalId);
    assert.equal(approval?.action, 'git.merge');
    assert.equal(approval.state, 'approved');
    assert.equal(approval.boundary, 'control-plane-git');
    assert.equal(approval.enforcementMode, 'enforced');
    assert.equal(approval.resource.mergeCommit, review.mergeCommit);
    assert.equal(approval.resource.targetHead, review.targetHead);
    assert.equal(approval.resource.targetBranch, review.targetBranch);
    const sourceFile = path.join(source.rootPath, 'welcome.txt');
    assert.deepEqual(
      fs.readFileSync(sourceFile),
      bytes,
      'Merged source file matches reviewed task output',
    );
    merge = {
      verified: true,
      reviewId: review.id,
      approvalId: review.approvalId,
      targetBranch: review.targetBranch,
      targetHead: review.targetHead,
      mergeCommit: review.mergeCommit,
      sourceFile,
      events: reviewEvents.map((item) => item.id),
    };
  }
  save(options['before-merge'] ? 'collaboration-verification.json' : 'verification.json', {
    ...base,
    passed: true,
    scope: options['before-merge']
      ? 'worker-messaging-and-task-file-only'
      : 'worker-messaging-file-delivery-and-approved-merge',
    actorConfigurationAtCheck: [senderDefinition, recipientDefinition].map((item) => ({
      id: item.id,
      canBeBoss: item.orchestration.canBeBoss,
      bridge: item.controlBridge,
    })),
    messages: [request, reply, finalHandoff].map((item) => ({
      id: item.id,
      from: item.fromAgentId,
      to: item.toAgentId,
      type: item.type,
      replyTo: item.replyTo,
      artifactRefs: item.artifactRefs,
      delivery: snapshot.messageDeliveries.find((row) => row.messageId === item.id),
    })),
    conversations: conversations.map(
      ({ taskId, agentId, executionAttemptId, sessionId, protocol }) => ({
        taskId,
        agentId,
        executionAttemptId,
        sessionId,
        protocol,
      }),
    ),
    promptTurns: turns,
    artifacts,
    file: { path: resultFile, text, sha256: createHash('sha256').update(bytes).digest('hex') },
    sourceWorkspace: source.rootPath,
    taskWorkspace: workspace.rootPath,
    merge,
    limits:
      'This check observes one real mainline at checkedAt. Later source-file edits require a new task/review checkpoint and may make an old live verification fail without changing its historical evidence. Absence of duplicate recorded messages is not a concurrency/restart fault test. Bridge configuration is recorded at check time; prompt/session/route evidence records actual execution.',
  });
}
