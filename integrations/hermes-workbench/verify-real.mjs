import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration/real-20261023');
const { url } = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
async function read(route) {
  const response = await fetch(url + route);
  assert.equal(response.status, 200, route);
  return response;
}
const snapshot = await (await read('/api/control-center')).json();
const roots = snapshot.tasks.filter((t) => !t.parentTaskId);
const savedFile = path.join(run, 'verification.json');
const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : null;
const task = saved ? roots.find((t) => t.id === saved.rootTaskId) : roots[0];
assert.ok(task, 'The original browser-submitted acceptance task is retained');
const children = snapshot.tasks.filter((t) => t.parentTaskId === task.id);
assert.equal(children.length, 1);
const child = children[0];
assert.equal(task.state, 'completed');
assert.equal(child.state, 'completed');
assert.equal(snapshot.assignments.find((a) => a.taskId === task.id).agentId, 'codex-acceptance');
assert.equal(
  snapshot.assignments.find((a) => a.taskId === child.id).agentId,
  'antigravity-acceptance',
);
const ledger = JSON.parse(fs.readFileSync(path.join(run, 'prompt-budget.json'), 'utf8'));
assert.equal(ledger.limit, 3);
assert.equal(ledger.used, 3);
assert.deepEqual(
  ledger.turns.map((t) => t.agentId),
  ['codex-acceptance', 'antigravity-acceptance', 'codex-acceptance'],
);
const events = snapshot.timeline.filter((e) => e.projectId === task.projectId);
const tools = events.filter((e) => e.type === 'fleet.tool' && e.payload.outcome === 'succeeded');
for (const name of ['control_discover_agents', 'control_delegate_task', 'control_get_artifact'])
  assert.ok(
    tools.some((e) => e.payload.toolName === name),
    name,
  );
assert.ok(events.some((e) => e.type === 'message.delivered'));
assert.ok(
  tools.some(
    (e) =>
      e.taskId === task.id &&
      e.payload.toolName === 'control_get_artifact' &&
      child.resultArtifactRefs.includes(e.payload.input?.artifactId),
  ),
  'Leader reads the actual worker artifact',
);
assert.ok(
  snapshot.messages.some(
    (m) =>
      m.taskId === child.id &&
      m.fromAgentId === 'antigravity-acceptance' &&
      m.toAgentId === 'codex-acceptance',
  ),
);
const artifacts = [];
for (const item of [task, child]) {
  assert.ok(item.resultArtifactRefs.length > 0);
  for (const id of item.resultArtifactRefs) {
    const text = await (await read(`/api/artifacts/${encodeURIComponent(id)}/content`)).text();
    assert.ok(text.trim().length > 20);
    artifacts.push({
      taskId: item.id,
      id,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }
}
const result = {
  passed: true,
  sourceOfTask: 'Submitted through Hermes workbench browser UI',
  rootTaskId: task.id,
  childTaskId: child.id,
  url: `${url}/?task=${task.id}`,
  promptBudget: ledger,
  artifacts,
  toolNames: tools.map((e) => e.payload.toolName),
  deliveredEvents: events.filter((e) => e.type === 'message.delivered').map((e) => e.id),
  approvals: snapshot.approvals
    .filter((a) => a.projectId === task.projectId)
    .map((a) => ({
      id: a.id,
      state: a.state,
      action: a.action,
      enforcementMode: a.enforcementMode,
      boundary: a.boundary,
    })),
  checkedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(run, 'verification.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(
  path.join(run, 'final-result.txt'),
  artifacts
    .filter((a) => a.taskId === task.id)
    .map((a) => a.text)
    .join('\n'),
);
console.log(JSON.stringify(result, null, 2));
