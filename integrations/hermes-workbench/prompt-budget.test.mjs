import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPromptBudget } from './prompt-budget.mjs';

test('global allowance forwards three prompts across agents and survives reopening', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-budget-test-'));
  const filename = path.join(folder, 'ledger.json');
  const budget = createPromptBudget(filename, 3);
  const forwarded = [];
  const writer = (id) =>
    budget
      .wrap(
        new WritableStream({
          write(chunk) {
            forwarded.push(new TextDecoder().decode(chunk));
          },
        }),
        id,
      )
      .getWriter();
  const boss = writer('boss');
  const worker = writer('worker');
  const frame = new TextEncoder().encode(
    JSON.stringify({ method: 'session/prompt', params: { sessionId: 'test' } }) + '\n',
  );
  await boss.write(frame);
  await worker.write(frame);
  await boss.write(frame);
  await assert.rejects(worker.write(frame), /budget exhausted/);
  assert.equal(forwarded.length, 3);
  assert.equal(createPromptBudget(filename, 3).read().used, 3);
  assert.deepEqual(
    budget.read().turns.map((t) => t.agentId),
    ['boss', 'worker', 'boss'],
  );
  // Remove only the two exact fixture paths created by this test.
  fs.unlinkSync(filename);
  fs.rmdirSync(folder);
});
