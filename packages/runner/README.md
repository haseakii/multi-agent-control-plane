# runner

Provider-neutral runner contracts and the V0 `LocalRunner` implementation.

## LocalRunner

Responsibilities:
- spawn and stop child processes
- expose runner/process identity and status
- stream normalized stdout/stderr/lifecycle events
- write/end stdin
- enforce bounded inherited/explicit environment values
- track exits
- support timeout and AbortSignal cancellation hooks
- expose labels and capabilities for future runner selection

The runner does **not** own ACP session semantics. `@control-plane/acp-runtime` consumes a process transport/event stream in a later integration layer.

## Security

LocalRunner is not a sandbox. It runs with the control-plane OS user's permissions. By default it inherits only a small set of OS/runtime environment keys and never logs the environment itself. Strong filesystem/network isolation requires a future container/remote runner or restricted OS account.

## Completed process retention

LocalRunner releases the full process and raw transport record on exit. It retains
at most 64 completed status/event entries and 4 MiB of cached output history by default;
`completedProcessLimit` and `completedOutputBytesLimit` configure these bounds.
Older output is discarded first without interrupting existing event subscribers.
Evicted handles are no longer readable through runner methods. Persist task results
and required logs as artifacts before relying on them as history; this cache is not
the durable task store. Active processes are never evicted by these limits.
