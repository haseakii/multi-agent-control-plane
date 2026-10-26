import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration/real-20261023');
const server = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
async function json(route) {
  const response = await fetch(server.url + route);
  assert.equal(response.status, 200);
  return response.json();
}
const info = await json('/api/workbench');
assert.equal(info.profile, 'daily');
assert.equal(info.budget, undefined);
const snapshot = await json('/api/control-center');
const firstId = 'task-87da23f9-eb9e-47e5-bbd3-0e10f09e1639';
const link = snapshot.timeline.find(
  (e) => e.type === 'task.followup.created' && e.payload.sourceTaskId === firstId,
);
assert.ok(link);
const tasks = [
  snapshot.tasks.find((t) => t.id === firstId),
  snapshot.tasks.find((t) => t.parentTaskId === firstId),
  snapshot.tasks.find((t) => t.id === link.taskId),
];
assert.deepEqual(
  tasks.map((t) => t.state),
  ['completed', 'completed', 'completed'],
);
assert.deepEqual(
  tasks.map((t) => snapshot.assignments.find((a) => a.taskId === t.id).agentId),
  ['codex-acceptance', 'antigravity-acceptance', 'codex-acceptance'],
);
const instructions = await json(`/api/tasks/${firstId}/instructions`);
assert.ok(
  instructions.instructions.some(
    (i) => i.state === 'delivered' && i.content.includes('不要出现协议或配置术语'),
  ),
);
const context = snapshot.timeline.find(
  (e) => e.taskId === link.taskId && e.type === 'execution.context.prepared',
)?.payload.context;
assert.ok(context.dependencies.some((t) => t.id === firstId));
assert.ok(context.artifacts.some((a) => tasks[0].resultArtifactRefs.includes(a.id)));
const results = [];
for (const task of tasks) {
  for (const artifactId of task.resultArtifactRefs) {
    const response = await fetch(`${server.url}/api/artifacts/${artifactId}/content`);
    assert.equal(response.status, 200);
    results.push({ taskId: task.id, artifactId, text: await response.text() });
  }
}
const usage = JSON.parse(fs.readFileSync(path.join(run, 'daily-prompt-usage.json'), 'utf8'));
assert.equal(usage.limit, null);
assert.ok(usage.used >= 4);
const acceptance = JSON.parse(fs.readFileSync(path.join(run, 'prompt-budget.json'), 'utf8'));
assert.equal(acceptance.used, 3);
const result = {
  passed: true,
  url: `${server.url}/?task=${firstId}`,
  source: 'Browser UI: new goal, in-flight clarification, completed-turn follow-up',
  conversationRootTaskId: firstId,
  followUpTaskId: link.taskId,
  instructions: instructions.instructions,
  results,
  dailyPrompts: usage.used,
  historicalAcceptancePrompts: acceptance.used,
  serverPid: server.pid,
  checkedAt: new Date().toISOString(),
};
if (process.argv.includes('--after-restart')) {
  const previous = JSON.parse(fs.readFileSync(path.join(run, 'daily-verification.json'), 'utf8'));
  assert.notEqual(previous.serverPid, result.serverPid);
  assert.deepEqual(previous.results, result.results);
  assert.equal(previous.dailyPrompts, result.dailyPrompts);
  result.restartVerified = true;
}
fs.writeFileSync(path.join(run, 'daily-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
