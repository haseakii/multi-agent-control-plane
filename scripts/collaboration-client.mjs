import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// Stable stdio entry: release switches update the existing private connection,
// never the surrounding Codex configuration or its Windows section.
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--connection') throw Error();
  const filename = resolve(process.argv[3]);
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  const installationIndex = config.start.args.indexOf('--installation');
  if (installationIndex >= 0) {
    const installationFile = resolve(config.start.args[installationIndex + 1]);
    const state = JSON.parse(readFileSync(installationFile, 'utf8'));
    if (state.version !== 1) throw Error('Unsupported installation.');
    const child = spawn(
      state.runtimeFile,
      [
        join(dirname(installationFile), 'launcher/control-plane.mjs'),
        'mcp',
        '--installation',
        installationFile,
        '--connection',
        filename,
      ],
      { windowsHide: true, stdio: 'inherit' },
    );
    child.once('error', () => {
      process.exitCode = 1;
    });
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } else {
    const root = realpathSync(join(dirname(config.start.command), '..'));
    const entry = join(root, 'node_modules/@control-plane/fleet-mcp/dist/client-stdio-main.js');
    const server = join(root, 'apps/server/dist/release-main.js');
    if (realpathSync(config.start.command) !== realpathSync(join(root, 'runtime/node.exe')))
      throw Error();
    realpathSync(server);
    process.argv = [process.execPath, entry, '--connection', filename];
    await import(pathToFileURL(entry).href);
  }
} catch {
  console.error(
    'Collaboration MCP entry is unavailable. Preserve the connection file and inspect the selected release.',
  );
  process.exitCode = 1;
}
