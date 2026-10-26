import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { BackgroundStartSchema } from './background-launch.js';

// The broker passes only a local configuration path. Never put credentials in argv/logs.
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--connection') throw new Error();
  const start = BackgroundStartSchema.parse(
    JSON.parse(readFileSync(process.argv[3]!, 'utf8')).start,
  );
  mkdirSync(dirname(start.logFile), { recursive: true });
  const log = openSync(start.logFile, 'a');
  try {
    const child = spawn(start.command, start.args, {
      cwd: start.cwd,
      windowsHide: true,
      stdio: ['ignore', log, log],
    });
    child.once('error', () => {
      process.exitCode = 1;
    });
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } finally {
    closeSync(log);
  }
} catch {
  process.exitCode = 1;
}
