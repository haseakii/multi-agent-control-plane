import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClientMcpServer, createClientHttpTransport } from './client-server.js';

it('advertises validated MCP collaboration tools without approval/merge authority', async () => {
  const invoke = vi.fn(async () => ({ projects: [{ id: 'p', name: 'Project' }] }));
  const server = createClientMcpServer({ invoke }),
    client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(9);
    for (const name of ['collaboration_submit_task', 'collaboration_continue_task'])
      expect(tools.find((t) => t.name === name)?.inputSchema.properties).toHaveProperty(
        'attachments',
      );
    expect(tools.some((t) => /approve|merge|push/.test(t.name))).toBe(false);
    expect(
      (await client.callTool({ name: 'collaboration_list_projects', arguments: {} }))
        .structuredContent,
    ).toEqual({ projects: [{ id: 'p', name: 'Project' }] });
    const invalid = await client.callTool({
      name: 'collaboration_submit_task',
      arguments: { projectId: 'p' },
    });
    expect(invalid.isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
it('refuses nonlocal origins before using its local credential', () => {
  expect(() => createClientHttpTransport('https://example.com', 'a'.repeat(64))).toThrow();
  expect(() => createClientHttpTransport('http://127.0.0.1:8057/', 'a'.repeat(64))).not.toThrow();
});
