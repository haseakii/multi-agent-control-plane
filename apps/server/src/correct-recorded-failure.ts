import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nativeTurnFailure } from '@control-plane/acp-runtime';
import {
  AuditEventSchema,
  AssignmentSchema,
  ExecutionAttemptSchema,
  TaskSchema,
} from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';

const Correction = z
  .object({
    taskId: z.string().min(1),
    attemptId: z.string().min(1),
    artifactId: z.string().min(1),
    agentInfo: z
      .object({ name: z.literal('antigravity-acp'), version: z.literal('1.4.1') })
      .strict(),
  })
  .strict();

/** Offline maintenance only, after operator diagnosis. No HTTP or MCP mutation route.
 * Retains original events/artifacts and appends a correction; never rewrites workspace files.
 */
export function correctRecordedAgentFailure(
  storage: SqliteStorage,
  input: unknown,
  content: Uint8Array,
) {
  const value = Correction.parse(input),
    repo = storage.repositories;
  const artifact = repo.artifacts.get(value.artifactId);
  if (
    !artifact ||
    artifact.taskId !== value.taskId ||
    !['log', 'report'].includes(artifact.kind) ||
    createHash('sha256').update(content).digest('hex') !== artifact.sha256
  )
    throw new Error('Correction evidence does not match the saved artifact.');
  const failure = nativeTurnFailure(
    value.agentInfo,
    new TextDecoder('utf-8', { fatal: true }).decode(content),
  );
  if (!failure) throw new Error('No recognized adapter failure in the evidence.');
  return repo.transaction(() => {
    const task = repo.tasks.get(value.taskId),
      attempt = repo.executionAttempts.get(value.attemptId);
    const assignment = attempt && repo.assignments.get(attempt.assignmentId);
    if (
      !task ||
      !attempt ||
      !assignment ||
      attempt.taskId !== task.id ||
      artifact.assignmentId !== assignment.id ||
      artifact.producerAgentId !== assignment.agentId ||
      assignment.attempt !== attempt.number
    )
      throw new Error('Correction target no longer matches the saved execution.');
    if (task.state === 'failed' && attempt.failure?.code === failure.code)
      return { corrected: false, task };
    if (
      task.state !== 'completed' ||
      attempt.state !== 'completed' ||
      assignment.state !== 'completed' ||
      repo.workspaceReviews.list().some((r) => r.taskId === task.id)
    )
      throw new Error('Only an unreviewed, falsely completed execution can be corrected.');
    const updatedAt = new Date().toISOString();
    const correctedTask = TaskSchema.parse({ ...task, state: 'failed', updatedAt });
    repo.tasks.upsert(correctedTask);
    repo.assignments.upsert(AssignmentSchema.parse({ ...assignment, state: 'failed', updatedAt }));
    repo.executionAttempts.upsert(
      ExecutionAttemptSchema.parse({ ...attempt, state: 'failed', failure, updatedAt }),
    );
    repo.events.append(
      AuditEventSchema.parse({
        id: 'event-' + randomUUID(),
        projectId: task.projectId,
        taskId: task.id,
        type: 'execution.outcome.corrected',
        actor: { type: 'user', id: 'local-operator' },
        payload: {
          attemptId: attempt.id,
          artifactId: artifact.id,
          previousState: 'completed',
          state: 'failed',
          ...failure,
          adapter: value.agentInfo,
        },
        occurredAt: updatedAt,
      }),
    );
    return { corrected: true, task: correctedTask };
  });
}
