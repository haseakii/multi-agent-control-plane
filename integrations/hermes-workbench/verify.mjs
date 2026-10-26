import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration');
const server = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
const afterRestart = process.argv.includes('--after-restart');
const beforeFile = path.join(run, 'verification-before-restart.json');
const before = afterRestart ? JSON.parse(fs.readFileSync(beforeFile, 'utf8')) : null;
async function read(url) {
  const response = await fetch(server.url + url);
  assert.equal(response.status, 200, url);
  return response;
}
const snapshot = await (await read('/api/control-center')).json();
const task = before
  ? snapshot.tasks.find((t) => t.id === before.rootTaskId)
  : snapshot.tasks.filter((t) => !t.parentTaskId && t.state === 'completed').at(-1);
assert.ok(task, 'A browser-submitted completed task must exist');
assert.equal(task.state, 'completed');
const children = snapshot.tasks.filter((t) => t.parentTaskId === task.id);
assert.equal(children.length, 1);
assert.equal(children[0].state, 'completed');
const rootAssignment = snapshot.assignments.find((a) => a.taskId === task.id);
assert.equal(rootAssignment.agentId, 'mock-reviewer', 'UI-selected leader must execute');
const childAssignment = snapshot.assignments.find((a) => a.taskId === children[0].id);
assert.equal(childAssignment.agentId, 'mock-worker');
assert.equal(
  snapshot.projects.find((p) => p.id === task.projectId).defaultBossAgentId,
  'mock-reviewer',
);
const artifactHashes = {};
for (const item of [task, ...children]) {
  assert.equal(item.resultArtifactRefs.length, 1);
  for (const id of item.resultArtifactRefs) {
    const body = await (await read('/api/artifacts/' + encodeURIComponent(id) + '/content')).text();
    assert.match(body, /323/);
    artifactHashes[id] = createHash('sha256').update(body).digest('hex');
  }
}
const attempts = snapshot.executionAttempts.filter((a) =>
  [task.id, children[0].id].includes(a.taskId),
);
assert.equal(
  attempts.length,
  2,
  'Leader and worker have separate execution attempts; continuation stays in the leader attempt',
);
assert.ok(
  snapshot.messages.some(
    (m) =>
      m.taskId === children[0].id &&
      m.fromAgentId === 'mock-worker' &&
      m.toAgentId === 'mock-reviewer',
  ),
  'Worker result must be routed back to the selected leader',
);
assert.ok(
  snapshot.timeline.some((e) => e.projectId === task.projectId && e.type === 'message.delivered'),
  'Durable completion notification must be delivered',
);
if (before) {
  assert.notEqual(server.pid, before.serverPid);
  assert.deepEqual(artifactHashes, before.artifactHashes);
  assert.deepEqual(attempts.map((a) => a.id).sort(), before.attemptIds);
}
const result = {
  passed: true,
  rootTaskId: task.id,
  childTaskId: children[0].id,
  selectedLeader: rootAssignment.agentId,
  worker: childAssignment.agentId,
  artifactHashes,
  attemptIds: attempts.map((a) => a.id).sort(),
  eventTypes: [
    ...new Set(snapshot.timeline.filter((e) => e.projectId === task.projectId).map((e) => e.type)),
  ],
  serverPid: server.pid,
  restartVerified: afterRestart,
  realAgentPrompts: 0,
  sourceOfTask: 'Submitted through Hermes workbench browser UI',
  checkedAt: new Date().toISOString(),
};
fs.writeFileSync(
  afterRestart ? path.join(run, 'verification.json') : beforeFile,
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
