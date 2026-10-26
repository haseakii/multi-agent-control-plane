// Read-only verification of the real Antigravity -> Codex -> Antigravity flow.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const run = '.run/hermes-integration/real-20261023';
const { url } = JSON.parse(fs.readFileSync(`${run}/server.json`, 'utf8'));
const json = async (route) => {
  const response = await fetch(url + route);
  assert.equal(response.status, 200);
  return response.json();
};
const s = await json('/api/control-center');
const task = s.tasks.find((t) => t.id === 'task-dcf878dd-16af-41a3-a133-b1b5e9fa1c9f');
assert.equal(task?.state, 'completed');
const children = s.tasks.filter((t) => t.parentTaskId === task.id);
assert.equal(children.length, 1);
const worker = children[0];
assert.equal(worker.state, 'completed');
const assignments = [task, worker].map((t) => s.assignments.find((a) => a.taskId === t.id));
assert.deepEqual(
  assignments.map((a) => a.agentId),
  ['antigravity-acceptance', 'codex-collaborator'],
);
const sessions = assignments.map(
  (a) =>
    s.timeline.find((e) => e.type === 'conversation.attached' && e.payload.assignmentId === a.id)
      ?.payload.sessionId,
);
assert.ok(sessions.every(Boolean));
assert.equal(new Set(sessions).size, 2);
const usage = JSON.parse(fs.readFileSync(`${run}/daily-prompt-usage.json`, 'utf8'));
const turns = usage.turns.filter((t) => sessions.includes(t.sessionId));
assert.deepEqual(
  turns.map((t) => t.agentId),
  ['antigravity-acceptance', 'codex-collaborator', 'antigravity-acceptance'],
);
const calls = s.timeline.filter((e) => e.taskId === task.id && e.type === 'fleet.tool');
const tools = [
  'control_discover_agents',
  'control_create_task',
  'control_delegate_task',
  'control_get_artifact',
];
for (const name of tools)
  assert.ok(
    calls.some(
      (e) =>
        e.payload.toolName === name &&
        e.payload.outcome === 'succeeded' &&
        e.payload.boundary === 'fleet-gateway' &&
        e.payload.enforcementMode === 'enforced',
    ),
  );
assert.ok(
  calls.some(
    (e) =>
      e.payload.toolName === 'control_get_artifact' &&
      worker.resultArtifactRefs.includes(e.payload.input.artifactId),
  ),
);
const approvals = s.approvals.filter((a) => a.taskId === task.id);
assert.equal(approvals.length, 4);
assert.ok(
  approvals.every(
    (a) =>
      a.state === 'approved' &&
      a.acp.review.status === 'complete' &&
      a.boundary === 'acp-permission' &&
      a.enforcementMode === 'cooperative',
  ),
);
const response = s.messages.find(
  (m) =>
    m.taskId === worker.id &&
    m.fromAgentId === 'codex-collaborator' &&
    m.toAgentId === 'antigravity-acceptance' &&
    m.artifactRefs.includes(worker.resultArtifactRefs[0]),
);
assert.ok(response);
assert.equal(s.messageDeliveries.find((d) => d.messageId === response.id)?.state, 'delivered');
const results = [];
for (const t of [worker, task]) {
  const artifactId = t.resultArtifactRefs[0];
  const metadata = s.artifacts.find((a) => a.id === artifactId);
  const r = await fetch(`${url}/api/artifacts/${encodeURIComponent(artifactId)}/content`);
  assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, metadata.sha256);
  results.push({ taskId: t.id, artifactId, sha256, text: bytes.toString('utf8').trim() });
}
assert.ok(results[1].text.includes(results[0].text));
assert.ok(Array.from(results[0].text).length <= 30);
const evidence = {
  passed: true,
  checkedAt: new Date().toISOString(),
  taskId: task.id,
  workerTaskId: worker.id,
  agents: assignments.map((a) => a.agentId),
  sessions,
  prompts: turns,
  approvalIds: approvals.map((a) => a.id),
  tools,
  responseMessageId: response.id,
  results,
  initiation:
    'Hermes input and send UI; narrowly checked test approvals used the normal operator API',
};
const file = `${run}/alternate-boss-verification.json`;
fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify({
    passed: true,
    taskId: task.id,
    workerTaskId: worker.id,
    prompts: turns.length,
    result: results[0].text,
  }),
);
