import { parseAgentCommand } from './agent-quick-config';

type Runtime = ReturnType<typeof parseAgentCommand>['runtime'];

/** A preview only. Suggested arguments are shown before registration/probe. */
export function prepareProductEntry(runtime: Runtime, suggestedArgs: string[]) {
  const script =
    /(?:^|[\\/])node(?:\.exe)?$/i.test(runtime.command) &&
    !!runtime.args[0] &&
    /\.(?:c|m)?js$/i.test(runtime.args[0]);
  const hasParameters = runtime.args.length > (script ? 1 : 0);
  const args = hasParameters ? runtime.args : [...runtime.args, ...suggestedArgs];
  return parseAgentCommand(
    JSON.stringify({
      command: runtime.command,
      args,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
      ...(runtime.environmentAllowlist
        ? { environmentAllowlist: runtime.environmentAllowlist }
        : {}),
    }),
  ).runtime;
}
