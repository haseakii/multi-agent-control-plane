import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectAgentConfiguration } from './agent-diagnostics.js';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
  console.log(
    'Usage: pnpm diagnose:agent [--config PATH]\nOffline only: reads the selected JSON config and checks file metadata. Never launches an agent, reads credentials, authenticates, or makes a network request.',
  );
} else if (args.length !== 0 && !(args.length === 2 && args[0] === '--config')) {
  console.error('Usage: pnpm diagnose:agent [--config PATH]. Agent execution is not supported.');
  process.exitCode = 2;
} else {
  const filename =
    args[1] ??
    fileURLToPath(
      new URL('../../../examples/agents/codex-acp.windows.disabled.json', import.meta.url),
    );
  try {
    const result = inspectAgentConfiguration(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.offlineChecksPassed ? 0 : 1;
  } catch {
    // Do not print config content, arguments, environment values, or raw parser errors.
    console.error(
      JSON.stringify({
        code: 'CONFIG_UNREADABLE',
        message: 'Cannot read or parse the selected JSON configuration.',
        runtime: 'not_started',
        authentication: 'not_checked',
        model: 'not_requested',
      }),
    );
    process.exitCode = 1;
  }
}
