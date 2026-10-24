import { describe, expect, it } from 'vitest';
import type { BridgeScope } from '@control-plane/core';
import {
  createFleetPermissionMetadataValidator,
  createFleetPermissionResolver,
  type FleetPermissionRequest,
} from './permission-resolver.js';
import { fleetToolDefinitions } from './server.js';

const context = {
  serverName: 'control-plane-fleet',
  projectId: 'project-1',
  taskId: 'sender-task',
};
const adapter = { name: 'antigravity-acp', version: '1.4.1' };
const metadata = {
  mcp: { tool: 'control_discover_agents', server: 'control-plane-fleet' },
  is_mcp_tool_call: true,
};
function resolver(scopes: readonly BridgeScope[] = ['boss.orchestration']) {
  return createFleetPermissionResolver({ ...context, scopes });
}
function request(toolCall: Record<string, unknown>): FleetPermissionRequest {
  return { sessionId: 'session-1', agentInfo: adapter, toolCall };
}

describe('scoped Fleet ACP permission semantics', () => {
  it('validates the exact observed metadata and uses it as the preferred identity', () => {
    const validate = createFleetPermissionMetadataValidator({
      ...context,
      scopes: ['boss.orchestration'],
    });
    expect(validate({ sessionId: 'session-1', agentInfo: adapter, metadata })).toBe(true);
    const resolve = resolver();
    for (const identity of [
      {},
      { title: 'control-plane-fleet_control_discover_agents' },
      { name: 'control_discover_agents', title: 'control-plane-fleet_control_discover_agents' },
      { name: 'control-plane-fleet_control_discover_agents' },
    ]) {
      expect(
        resolve(request({ ...identity, _meta: metadata, rawInput: { arguments: {} } })),
      ).toMatchObject({
        tool: 'control_discover_agents',
        action: 'agents.discover',
        target: 'project:project-1',
        parameters: { fleet: { identitySource: 'antigravity-acp@1.4.1:metadata' } },
      });
    }
  });

  it('rejects unknown metadata fields, identities, servers and scopes', () => {
    const validate = createFleetPermissionMetadataValidator({
      ...context,
      scopes: ['boss.orchestration'],
    });
    const base = { sessionId: 'session-1', agentInfo: adapter, metadata };
    for (const invalid of [
      null,
      {},
      { mcp: metadata.mcp },
      { ...metadata, is_mcp_tool_call: false },
      { ...metadata, extra: 'unknown' },
      { ...metadata, mcp: { ...metadata.mcp, extra: 'unknown' } },
      { ...metadata, mcp: { ...metadata.mcp, server: 'other-server' } },
      { ...metadata, mcp: { ...metadata.mcp, tool: 'other-tool' } },
      { ...metadata, mcp: { ...metadata.mcp, tool: 'control_send_message' } },
    ]) {
      expect(validate({ ...base, metadata: invalid })).toBe(false);
      expect(
        resolver()(request({ name: 'control_discover_agents', _meta: invalid, rawInput: {} })),
      ).toBeNull();
    }
    for (const agentInfo of [
      null,
      { name: 'other', version: '1.4.1' },
      { name: 'antigravity-acp', version: '1.4.2' },
    ]) {
      expect(validate({ ...base, agentInfo })).toBe(false);
    }
    expect(createFleetPermissionMetadataValidator({ ...context, scopes: [] })(base)).toBe(false);
  });

  it('rejects explicit name or title conflicts with a validated descriptor', () => {
    for (const identity of [
      { name: 'control_get_agent' },
      { name: 'other_control_discover_agents' },
      { name: null },
      { title: 'control-plane-fleet_control_get_agent' },
      { title: 'other_control_discover_agents' },
      { title: 'Discover agents' },
    ]) {
      expect(resolver()(request({ ...identity, _meta: metadata, rawInput: {} }))).toBeNull();
    }
  });

  it('resolves the observed pinned Antigravity discovery envelope', () => {
    expect(
      resolver()(
        request({
          title: 'control-plane-fleet_control_discover_agents',
          kind: 'other',
          status: 'pending',
          rawInput: { arguments: {} },
        }),
      ),
    ).toEqual({
      tool: 'control_discover_agents',
      action: 'agents.discover',
      target: 'project:project-1',
      parameters: {
        input: {},
        fleet: { ...context, identitySource: 'antigravity-acp@1.4.1:title' },
      },
    });
  });

  it('accepts exact standard names independently of provider identity', () => {
    const resolve = resolver(['task.status']);
    for (const name of ['control_get_task', 'control-plane-fleet_control_get_task']) {
      expect(
        resolve({
          sessionId: 'session-1',
          agentInfo: null,
          toolCall: { name, title: 'Read a task', rawInput: { taskId: 'task-2' } },
        }),
      ).toMatchObject({ tool: 'control_get_task', action: 'tasks.read', target: 'task:task-2' });
    }
  });

  it('requires the pinned identity, version and complete server/tool title', () => {
    const resolve = resolver();
    const known = request({ title: 'control-plane-fleet_control_discover_agents', rawInput: {} });
    for (const agentInfo of [
      null,
      { name: 'other', version: '1.4.1' },
      { name: 'antigravity-acp', version: '1.4.2' },
    ]) {
      expect(resolve({ ...known, agentInfo })).toBeNull();
    }
    for (const title of [
      'control_discover_agents',
      'other_control_discover_agents',
      'Use control-plane-fleet_control_discover_agents',
      'control-plane-fleet_control_discover_agents ()',
    ]) {
      expect(resolve(request({ title, kind: 'other', rawInput: {} }))).toBeNull();
    }
  });

  it('does not fall back to a recognized title when an explicit name is unrecognized', () => {
    for (const name of ['unknown_tool', 'other_control_discover_agents', '', null]) {
      expect(
        resolver()(
          request({ name, title: 'control-plane-fleet_control_discover_agents', rawInput: {} }),
        ),
      ).toBeNull();
    }
  });

  it('only describes tools available through the attached scopes', () => {
    const discovery = request({ name: 'control_discover_agents', rawInput: {} });
    expect(resolver([])(discovery)).toBeNull();
    expect(resolver(['agent.messaging'])(discovery)).toBeNull();
    expect(
      resolver(['task.status'])(
        request({ name: 'control_cancel_task', rawInput: { taskId: 'task-2' } }),
      ),
    ).toBeNull();
    expect(
      resolver(['boss.orchestration'])(
        request({
          name: 'control_send_message',
          rawInput: { targetAgentId: 'peer', type: 'message' },
        }),
      ),
    ).toBeNull();
  });

  it('shows the recipient Agent and retains sender/recipient task routing without confusing them', () => {
    const input = {
      targetAgentId: 'peer',
      targetTaskId: 'recipient-task',
      taskId: 'sender-task',
      type: 'request',
      content: 'Please review this result.',
      idempotencyKey: 'review-1',
    };
    expect(
      resolver(['agent.messaging'])(
        request({
          title: 'control-plane-fleet_control_send_message',
          rawInput: { arguments: input, ...input },
        }),
      ),
    ).toEqual({
      tool: 'control_send_message',
      action: 'messages.send',
      target: 'agent:peer',
      parameters: {
        input,
        fleet: { ...context, identitySource: 'antigravity-acp@1.4.1:title' },
      },
    });
  });

  it('rejects missing, conflicting or unknown inputs rather than discarding them', () => {
    const resolve = resolver(['agent.messaging']);
    const args = { targetAgentId: 'peer', type: 'request', content: 'Review' };
    for (const rawInput of [
      undefined,
      null,
      JSON.stringify(args),
      {},
      { ...args, type: 'invalid' },
      { ...args, command: 'unexpected' },
      { arguments: args, targetAgentId: 'different-peer' },
      { arguments: args, extra: true },
      { arguments: [] },
      { arguments: { ...args, extra: true } },
    ]) {
      expect(resolve(request({ name: 'control_send_message', rawInput }))).toBeNull();
    }
  });

  it('covers every attached Fleet tool with its execution schema, action and concrete target', () => {
    const cases = [
      ['control_search_knowledge', { query: 'setup' }, 'project:project-1'],
      [
        'control_propose_memory',
        { kind: 'fact', title: 'Setup', content: 'Use local tools.' },
        'project:project-1',
      ],
      ['control_discover_agents', {}, 'project:project-1'],
      ['control_get_agent', { agentId: 'peer' }, 'agent:peer'],
      [
        'control_create_task',
        { title: 'Review', objective: 'Review this result' },
        'project:project-1',
      ],
      ['control_delegate_task', { taskId: 'task-2', agentId: 'peer' }, 'task:task-2; agent:peer'],
      ['control_get_task', { taskId: 'task-2' }, 'task:task-2'],
      ['control_wait_task', { taskId: 'task-2' }, 'task:task-2'],
      ['control_send_message', { targetAgentId: 'peer', type: 'message' }, 'agent:peer'],
      [
        'control_publish_artifact',
        { kind: 'text', mimeType: 'text/plain', content: 'Result' },
        'task:sender-task',
      ],
      ['control_get_artifact', { artifactId: 'artifact-2' }, 'artifact:artifact-2'],
      [
        'control_request_approval',
        { action: 'workspace.merge', resource: { workspaceId: 'workspace-2' } },
        'task:sender-task',
      ],
      ['control_cancel_task', { taskId: 'task-2' }, 'task:task-2'],
    ] as const;
    const resolve = resolver([
      'boss.orchestration',
      'agent.messaging',
      'artifact.publish',
      'artifact.read',
      'task.status',
      'knowledge.read',
      'memory.propose',
    ]);
    expect(cases.map(([tool]) => tool).sort()).toEqual(
      fleetToolDefinitions.map((tool) => tool.name).sort(),
    );
    for (const [tool, rawInput, target] of cases) {
      expect(resolve(request({ name: tool, rawInput }))).toMatchObject({
        tool,
        action: fleetToolDefinitions.find((definition) => definition.name === tool)?.operation,
        target,
      });
    }
  });

  it('does not retain a mutable reference to the host attachment scopes', () => {
    const scopes: BridgeScope[] = ['task.status'];
    const resolve = resolver(scopes);
    scopes.push('boss.orchestration');
    expect(resolve(request({ name: 'control_discover_agents', rawInput: {} }))).toBeNull();
  });
});
