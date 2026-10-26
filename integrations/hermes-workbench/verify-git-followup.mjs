// Read-only verification of the completed UI follow-up and its second local merge.
// Keeps the earlier three-agent checkpoint untouched; only writes new evidence files.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration/real-20261023');
const firstId = 'task-f898d9cb-c7ee-4df3-aca3-d9b685a1787e';
const followUpId = 'task-c3659246-20ff-4f47-b375-cbf80480a82e';
const firstCheckpoint = path.join(
  run,
  'git-messaging',
  firstId,
  'verification-2026-10-22T18-20-00-076Z.json',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const firstBytes = fs.readFileSync(firstCheckpoint);
const firstEvidence = JSON.parse(firstBytes);
assert.equal(firstEvidence.passed, true);
assert.equal(firstEvidence.merge.verified, true);
const { url, pid } = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
async function read(route) {
  const response = await fetch(url + route, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, route);
  return response;
}
const snapshot = await (await read('/api/control-center')).json();
const task = snapshot.tasks.find((item) => item.id === followUpId);
const first = snapshot.tasks.find((item) => item.id === firstId);
assert.equal(task?.state, 'completed');
assert.equal(first?.state, 'completed');
assert.equal(task.projectId, first.projectId);
assert.equal(task.parentTaskId, undefined);
assert.ok(task.dependencyIds.includes(firstId));
assert.ok(first.resultArtifactRefs.every((id) => task.contextRefs.includes(id)));
assert.deepEqual(
  first.resultArtifactRefs,
  firstEvidence.tasks.find((item) => item.id === firstId).resultArtifactRefs,
);
const events = snapshot.timeline.filter((item) => item.taskId === followUpId);
const link = events.find((item) => item.type === 'task.followup.created');
assert.equal(link?.payload.sourceTaskId, firstId);
assert.equal(link.payload.conversationRootTaskId, firstId);
const context = events.find((item) => item.type === 'execution.context.prepared')?.payload.context;
assert.ok(context?.dependencies.some((item) => item.id === firstId));
assert.ok(first.resultArtifactRefs.every((id) => context.artifacts.some((item) => item.id === id)));
assert.equal(
  snapshot.tasks.filter((item) => item.parentTaskId === followUpId).length,
  0,
  'Follow-up created no new worker tasks',
);
assert.ok(
  !events.some(
    (item) =>
      item.type === 'fleet.tool' &&
      ['control_delegate_task', 'control_send_message'].includes(item.payload.toolName),
  ),
  'No new delegation or routed request',
);
const assignments = snapshot.assignments.filter((item) => item.taskId === followUpId);
assert.equal(assignments.length, 1);
assert.equal(assignments[0].agentId, 'codex-acceptance');
const require = createRequire(new URL('../../packages/storage/package.json', import.meta.url));
const Sqlite = require('better-sqlite3');
const database = new Sqlite(path.join(run, 'data/state.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
let sessions;
try {
  sessions = database
    .prepare('SELECT payload FROM conversations WHERE task_id = ?')
    .all(followUpId)
    .map((row) => JSON.parse(row.payload));
} finally {
  database.close();
}
assert.equal(sessions.length, 1);
assert.equal(sessions[0].protocol, 'acp');
assert.equal(sessions[0].agentId, 'codex-acceptance');
const usage = JSON.parse(fs.readFileSync(path.join(run, 'daily-prompt-usage.json'), 'utf8'));
assert.equal(usage.limit, null);
const turns = usage.turns.filter((item) => item.sessionId === sessions[0].sessionId);
assert.equal(turns.length, 1, 'One real ACP prompt for the follow-up');
assert.equal(turns[0].ordinal, 16);
assert.equal(turns[0].agentId, 'codex-acceptance');

const originalArtifacts = [];
for (const original of firstEvidence.artifacts) {
  const bytes = Buffer.from(
    await (await read(`/api/artifacts/${encodeURIComponent(original.id)}/content`)).arrayBuffer(),
  );
  assert.equal(hash(bytes), original.sha256, 'Earlier artifact is preserved');
  originalArtifacts.push({ id: original.id, sha256: original.sha256 });
}
assert.equal(
  hash(fs.readFileSync(firstEvidence.file.path)),
  firstEvidence.file.sha256,
  'Original task worktree file is preserved',
);
const binding = snapshot.assignmentWorkspaces.filter((item) => item.taskId === followUpId).at(-1);
assert.equal(binding?.mode, 'git-worktree');
const worktree = snapshot.workspaces.find((item) => item.id === binding.workspaceId);
const source = snapshot.workspaces.find((item) => item.id === binding.sourceWorkspaceId);
assert.equal(worktree?.provider, 'git-worktree');
assert.notEqual(worktree.rootPath, firstEvidence.taskWorkspace);
const taskFile = path.join(worktree.rootPath, 'welcome.txt');
const sourceFile = path.join(source.rootPath, 'welcome.txt');
const taskBytes = fs.readFileSync(taskFile);
assert.deepEqual(
  fs.readFileSync(sourceFile),
  taskBytes,
  'Current source matches follow-up worktree',
);
assert.notEqual(
  hash(taskBytes),
  firstEvidence.file.sha256,
  'Follow-up actually changed the welcome copy',
);
const text = taskBytes.toString('utf8').trim();
assert.ok(text.length > 0);
assert.ok(Array.from(text).length <= 25, 'Copy satisfies the requested 25-character maximum');
const artifacts = [];
for (const id of task.resultArtifactRefs) {
  const metadata = snapshot.artifacts.find((item) => item.id === id);
  const bytes = Buffer.from(
    await (await read(`/api/artifacts/${encodeURIComponent(id)}/content`)).arrayBuffer(),
  );
  assert.equal(metadata?.taskId, task.id);
  assert.equal(metadata.sha256, hash(bytes));
  artifacts.push({
    id,
    sha256: hash(bytes),
    mimeType: metadata.mimeType,
    ...(metadata.mimeType.startsWith('text/') ? { text: bytes.toString('utf8') } : {}),
  });
}
const normalize = (value) => value.replace(/\s/g, '');
assert.ok(
  artifacts.some((item) => item.text && normalize(item.text).includes(normalize(text))),
  'Final reply matches current welcome.txt',
);
const reviews = await (await read(`/api/tasks/${followUpId}/workspace-reviews`)).json();
const merged = reviews.find((item) => item.review.state === 'merged');
assert.ok(merged);
assert.equal(merged.approvalState, 'approved');
const review = merged.review;
assert.equal(review.mergeCommit, '61aa79c64bf9ac794d7f5ec72553b163c699efce');
assert.equal(
  review.targetHead,
  firstEvidence.merge.mergeCommit,
  'Second merge starts from first merged revision',
);
assert.equal(review.baseRevision, firstEvidence.merge.mergeCommit);
assert.equal(review.workspaceId, binding.workspaceId);
assert.equal(review.sourceWorkspaceId, binding.sourceWorkspaceId);
assert.deepEqual(
  review.files.map(({ path, status }) => ({ path, status })),
  [{ path: 'welcome.txt', status: 'M' }],
);
const approval = snapshot.approvals.find((item) => item.id === review.approvalId);
assert.equal(approval?.state, 'approved');
assert.equal(approval.action, 'git.merge');
assert.equal(approval.boundary, 'control-plane-git');
assert.equal(approval.enforcementMode, 'enforced');
assert.equal(approval.resource.mergeCommit, review.mergeCommit);
assert.equal(approval.resource.targetHead, review.targetHead);
assert.equal(approval.resource.targetBranch, review.targetBranch);
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
assert.equal(
  hash(fs.readFileSync(firstCheckpoint)),
  hash(firstBytes),
  'Original verification checkpoint is untouched',
);
const result = {
  passed: true,
  checkedAt: new Date().toISOString(),
  serverPid: pid,
  source: 'Read-only check after UI follow-up, review, approval and explicit second merge',
  conversationRootTaskId: firstId,
  followUpTaskId: followUpId,
  url: `${url}/?task=${firstId}`,
  link,
  promptTurns: turns,
  noNewDelegation: true,
  session: sessions[0],
  priorEvidence: {
    path: firstCheckpoint,
    sha256: hash(firstBytes),
    artifactsPreserved: originalArtifacts,
    worktreeFilePreserved: firstEvidence.file.path,
    worktreeFileSha256: firstEvidence.file.sha256,
  },
  file: {
    taskFile,
    sourceFile,
    text,
    characters: Array.from(text).length,
    sha256: hash(taskBytes),
  },
  artifacts,
  merge: {
    reviewId: review.id,
    approvalId: review.approvalId,
    targetBranch: review.targetBranch,
    targetHead: review.targetHead,
    mergeCommit: review.mergeCommit,
    events: reviewEvents.map((item) => item.id),
  },
  limit:
    'Point-in-time evidence. A later approved edit may change the source file; original artifacts, task worktree and verification checkpoint are checked separately.',
};
const timestamped = path.join(
  run,
  `git-followup-verification-${result.checkedAt.replace(/[:.]/g, '-')}.json`,
);
fs.writeFileSync(timestamped, JSON.stringify(result, null, 2), { flag: 'wx' });
fs.writeFileSync(path.join(run, 'git-followup-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
