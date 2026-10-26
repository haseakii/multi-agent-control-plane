// Read-only evidence check for the task submitted through the Edge workbench.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration/real-20261023');
const server = JSON.parse(fs.readFileSync(path.join(run, 'server.json'), 'utf8'));
const response = await fetch(`${server.url}/api/control-center`);
assert.equal(response.status, 200);
const snapshot = await response.json();
const task = snapshot.tasks.find((item) => item.id === 'task-cadb7683-ecba-4da7-973a-f67b27f2a9a2');
assert.equal(task?.state, 'completed');
const child = snapshot.tasks.find((item) => item.parentTaskId === task.id);
assert.equal(child?.state, 'completed');
const actor = (id) => snapshot.assignments.find((item) => item.taskId === id)?.agentId;
assert.equal(actor(task.id), 'codex-acceptance');
assert.equal(actor(child.id), 'antigravity-acceptance');
const binding = snapshot.directoryBindings.find((item) => item.projectId === task.projectId);
assert.ok(binding);
assert.equal(snapshot.workspaceConfigs.find((item) => item.id === task.projectId)?.mode, 'shared-directory');
const target = path.join(binding.rootPath, 'result.txt');
const output = fs.readFileSync(target, 'utf8').trim();
assert.ok(output.length > 0);
const artifact = await fetch(`${server.url}/api/artifacts/${task.resultArtifactRefs[0]}/content`);
assert.equal(artifact.status, 200);
const finalReply = await artifact.text();
assert.ok(finalReply.includes(output));
assert.ok(finalReply.includes('result.txt'));
const handoff = snapshot.messages.find((item) => item.taskId === child.id && item.toAgentId === actor(task.id));
assert.ok(handoff);
assert.equal(snapshot.messageDeliveries.find((item) => item.messageId === handoff.id)?.state, 'delivered');
const usage = JSON.parse(fs.readFileSync(path.join(run, 'daily-prompt-usage.json'), 'utf8'));
assert.equal(usage.limit, null);
const result = {
  passed: true, checkedAt: new Date().toISOString(),
  source: 'Edge UI: folder selection, validation, explicit execution confirmation, send, collaboration, file delivery',
  url: `${server.url}/?task=${task.id}`, taskId: task.id, childTaskId: child.id,
  agents: [actor(task.id), actor(child.id)], workspace: binding.rootPath,
  file: target, text: output, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
  finalArtifact: task.resultArtifactRefs[0], handoffMessage: handoff.id, dailyPrompts: usage.used,
};
fs.writeFileSync(path.join(run, 'file-workflow-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
