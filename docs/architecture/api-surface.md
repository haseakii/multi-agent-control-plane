# Initial API Surface

This is a semantic API, not a frozen HTTP contract.

## Agent registry
- `POST /agents`
- `GET /agents`
- `GET /agents/:id`
- `PATCH /agents/:id`
- `POST /agents/:id/probe`
- `POST /agents/:id/auth`

## Projects
- `POST /projects`
- `GET /projects/:id`
- `PUT /projects/:id/boss`

## Tasks
- `POST /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/delegate`
- `POST /tasks/:id/cancel`
- `GET /tasks/:id/events`

## Messages
- `POST /messages`
- `GET /tasks/:id/messages`

## Artifacts
- `POST /artifacts`
- `GET /artifacts/:id`

## Approvals
- `GET /approvals?state=pending`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/reject`

## Realtime
WebSocket/SSE event stream for:
- task transitions
- assignment lifecycle
- agent events
- approvals
- messages
- runner state

## Fleet MCP surface
Preferred Boss tool names:
- `control_discover_agents`
- `control_get_agent`
- `control_create_task`
- `control_delegate_task`
- `control_get_task`
- `control_wait_task`
- `control_send_message`
- `control_publish_artifact`
- `control_get_artifact`
- `control_request_approval`
- `control_cancel_task`

All bridge operations call the same application services as HTTP/API clients.
