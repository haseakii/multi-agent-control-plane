import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
try {
  const args = process.argv.slice(2),
    index = args.indexOf('--installation');
  const file =
    index < 0
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../installation.json')
      : path.resolve(args[index + 1]);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 1) throw Error('Unsupported installation.');
  let selected = state.current;
  const record = path.join(path.dirname(file), 'operation.json');
  if (fs.existsSync(record)) {
    const op = JSON.parse(fs.readFileSync(record, 'utf8')),
      owner = args.indexOf('--operation');
    if (op.version !== 1) throw Error('Unknown maintenance state.');
    if (owner < 0 || args[owner + 1] !== op.token) selected = op.before;
  }
  if (!path.isAbsolute(selected.releaseDir)) throw Error('Invalid release path.');
  const child = spawn(
    path.join(selected.releaseDir, 'runtime/node.exe'),
    [
      path.join(selected.releaseDir, 'launcher/control-plane.mjs'),
      ...args,
      ...(index < 0 ? ['--installation', file] : []),
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  child.once('error', () => {
    console.error('工作台入口不可用，原目录和维护记录已保留。');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error('工作台入口读取失败：' + error.message);
  process.exitCode = 1;
}
