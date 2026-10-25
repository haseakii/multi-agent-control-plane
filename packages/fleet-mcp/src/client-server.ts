import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  clientToolDefinitions,
  ClientMcpSubmitSchema,
  ClientMcpContinueSchema,
  type ClientToolName,
} from './client-contract.js';
import { loopbackFetch } from './loopback-fetch.js';
import { prepareClientAttachments } from './client-input-attachments.js';

export interface ClientToolTransport {
  invoke(toolName: ClientToolName, input: unknown): Promise<Record<string, unknown>>;
}
export function createClientMcpServer(transport: ClientToolTransport) {
  const server = new McpServer(
    { name: 'local-collaboration', version: '0.1.0' },
    {
      instructions:
        'Use this server to collaborate with registered ACP agents from this conversation. Discover projects and agents, submit once, then wait for incremental progress with get_task (cursor and waitMs). Continue using the latest task ID. The same work is visible in the web workbench. Review/merge and sensitive permissions require the human there; never approve them yourself. Pass the relevant objective/context, not credentials or the whole chat. Reuse an idempotency key only for the same request retry. Large results are artifacts.',
    },
  );
  for (const tool of clientToolDefinitions) {
    const schema =
      tool.name === 'collaboration_submit_task'
        ? ClientMcpSubmitSchema
        : tool.name === 'collaboration_continue_task'
          ? ClientMcpContinueSchema
          : tool.schema;
    server.registerTool(
      tool.name,
      {
        description:
          tool.description +
          (tool.name === 'collaboration_submit_task' || tool.name === 'collaboration_continue_task'
            ? ' Optional attachments accepts explicitly user-authorized absolute local file paths; the stdio client uploads actual bytes without placing base64 or local paths in task payloads. Existing inputs are inherited on followup; omit attachments to retain them. Do not search for credentials or attach unrequested files.'
            : ''),
        inputSchema: schema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.name === 'collaboration_cancel_task',
          openWorldHint: !tool.readOnly,
        },
      },
      async (input: unknown) => {
        try {
          const result = await transport.invoke(tool.name, schema.parse(input));
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const message =
            error instanceof ClientTransportError
              ? error.message
              : 'Collaboration service failed. The task may still be running; inspect it before retrying a submission.';
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}
export class ClientTransportError extends Error {}
export function createClientHttpTransport(baseUrl: string, token: string): ClientToolTransport {
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Client bridge must use a plain loopback HTTP origin.');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local client credential.');
  return {
    async invoke(toolName, input) {
      let prepared: unknown;
      try {
        prepared = await prepareClientAttachments(toolName, input, async (query, bytes) => {
          const response = await loopbackFetch(
            new URL('/internal/client/input-attachments?' + query, url),
            {
              method: 'POST',
              signal: AbortSignal.timeout(45_000),
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/octet-stream',
              },
              body: bytes,
            },
          );
          const result = (await response.json()) as { attachment?: unknown; error?: string };
          if (!response.ok || !result.attachment)
            throw Error(result.error ?? 'Attachment upload failed.');
          return result.attachment;
        });
      } catch (error) {
        throw new ClientTransportError(
          error instanceof Error
            ? error.message
            : 'Attachment could not be prepared. Task was not sent; retain the same idempotency key for the same files.',
        );
      }
      let response: Response;
      try {
        response = await loopbackFetch(new URL('/internal/client/tool', url), {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(45_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ toolName, input: prepared }),
        });
      } catch {
        throw new ClientTransportError(
          'The local collaboration engine is unavailable or the wait expired. Keep the task ID and inspect it after reconnecting; do not submit a duplicate task.',
        );
      }
      const result = (await response.json()) as {
        result?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok || !result.result)
        throw new ClientTransportError(
          result.error ?? `Collaboration request failed (${response.status}).`,
        );
      return result.result;
    },
  };
}
