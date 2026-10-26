import type Database from 'better-sqlite3';
import {
  AgentIdSchema,
  AgentReferenceCountSchema,
  type AgentReferenceCount,
} from '@control-plane/core';

export interface AgentReferenceReader {
  list(agentId: string): AgentReferenceCount[];
}

/** Explicit domain references, counted without exposing record contents or credentials. */
export class SqliteAgentReferenceReader implements AgentReferenceReader {
  constructor(private readonly sqlite: Database.Database) {}
  list(raw: string): AgentReferenceCount[] {
    const agent = AgentIdSchema.parse(raw);
    const sources = [
      ['project', 'projects', "json_extract(payload, '$.defaultBossAgentId') = @agent"],
      ['boss-assignment', 'boss_assignments', "json_extract(payload, '$.agentId') = @agent"],
      ['task', 'tasks', "json_extract(payload, '$.ownerAgentId') = @agent"],
      ['assignment', 'assignments', 'agent_id = @agent'],
      ['conversation', 'conversations', 'agent_id = @agent'],
      ['message', 'messages', 'from_agent_id = @agent OR to_agent_id = @agent'],
      ['delivery', 'message_deliveries', 'recipient_agent_id = @agent'],
      ['artifact', 'artifacts', "json_extract(payload, '$.producerAgentId') = @agent"],
      ['approval', 'approvals', "json_extract(payload, '$.requesterAgentId') = @agent"],
      [
        'event',
        'events',
        "(json_extract(payload, '$.actor.type') = 'agent' AND json_extract(payload, '$.actor.id') = @agent) OR json_extract(payload, '$.payload.agentId') = @agent",
      ],
      [
        'memory',
        'project_memory',
        "(json_extract(payload, '$.proposedBy.type') = 'agent' AND json_extract(payload, '$.proposedBy.id') = @agent) OR (json_extract(payload, '$.reviewedBy.type') = 'agent' AND json_extract(payload, '$.reviewedBy.id') = @agent)",
      ],
    ] as const;
    return sources.flatMap(([kind, table, condition]) => {
      const { count } = this.sqlite
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${condition}`)
        .get({ agent }) as { count: number };
      return count ? [AgentReferenceCountSchema.parse({ kind, count })] : [];
    });
  }
}
