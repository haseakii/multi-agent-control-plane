import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import { describe, expect, it, vi } from 'vitest';
import { FleetBridgeHttpProxy } from './http-proxy.js';

function manifest() {
  return {
    identity: {
      agentId: AgentIdSchema.parse('boss-agent'),
      projectId: 'project-1',
      sessionId: 'session-1',
    },
    agent: AgentDefinitionSchema.parse({
      id: 'boss-agent',
      name: 'Boss',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
      capabilities: [{ name: 'planning', source: 'verified' }],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    }),
  };
}

describe('FleetBridgeHttpProxy', () => {
  it('uses the grant as bearer auth and never sends caller-controlled identity in tool payloads', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/internal/fleet/manifest')) {
        return new Response(JSON.stringify(manifest()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        toolName: 'control_get_task',
        input: { taskId: 'task-1' },
      });
      expect(JSON.stringify(body)).not.toContain('boss-agent');
      return new Response(JSON.stringify({ ok: true, result: { id: 'task-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const proxy = new FleetBridgeHttpProxy({
      baseUrl: 'http://127.0.0.1:3000/',
      grant: 'bridge-grant',
      fetchImpl,
    });

    expect((await proxy.manifest()).identity.agentId).toBe('boss-agent');
    const result = await proxy.services().getTask(
      { taskId: 'task-1' },
      {
        identity: manifest().identity,
        agent: manifest().agent,
        toolName: 'control_get_task',
        operation: 'tasks.read',
      },
    );
    expect(result).toEqual({ id: 'task-1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/internal/fleet/manifest',
      expect.objectContaining({
        headers: { authorization: 'Bearer bridge-grant' },
      }),
    );
  });

  it('surfaces gateway failures without echoing the grant token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'policy denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const proxy = new FleetBridgeHttpProxy({
      baseUrl: 'http://127.0.0.1:3000',
      grant: 'do-not-echo',
      fetchImpl,
    });

    await expect(
      proxy.services().cancelTask(
        { taskId: 'task-1' },
        {
          identity: manifest().identity,
          agent: manifest().agent,
          toolName: 'control_cancel_task',
          operation: 'tasks.cancel',
        },
      ),
    ).rejects.toThrow('policy denied');
  });
});
