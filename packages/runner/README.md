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
