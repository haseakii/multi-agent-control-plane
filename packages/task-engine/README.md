# task-engine

Durable task state machine, dependency graph, assignments, execution attempts, retry/cancellation semantics, conversation history, and restart recovery.

The package depends only on provider-neutral core contracts at runtime. Persistence is injected through structural repository interfaces; SQLite is used only in integration tests.

Key rules:
- Task is the durable unit of work.
- Assignment binds an agent/role to a task.
- ExecutionAttempt is an immutable-history execution generation under an assignment.
- ConversationRef belongs to a specific execution attempt; failed/replaced conversations are never overwritten.
- Generic state transitions do not silently reopen terminal tasks. Retry is an explicit command.
- Running attempts discovered after control-plane restart are marked interrupted and their tasks move to waiting.
