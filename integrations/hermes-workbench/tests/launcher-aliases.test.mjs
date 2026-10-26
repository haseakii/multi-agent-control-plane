import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Invalid fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control plane launchers-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'integrations/hermes-workbench'), { recursive: true });
  for (const name of [
    'start-hermes.cmd',
    '启动工作台.cmd',
    '停止工作台.cmd',
    'integrations/hermes-workbench/start.cmd',
    'integrations/hermes-workbench/start-real.cmd',
  ]) {
    fs.copyFileSync(path.join(source, name), path.join(root, name));
  }
  return root;
}
function run(root, file, args = []) {
  const result = spawnSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `""${path.join(root, file)}" ${args.join(' ')}"`],
    {
      cwd: root,
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CONTROL_PLANE_NO_PAUSE: '1' },
    },
  );
  if (result.error) throw result.error;
  return result;
}
it.runIf(process.platform === 'win32')(
  'routes common entry points to the daily launchers and preserves failures',
  () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, '启动工作台.cmd'),
      '@echo off\r\necho daily-start %*\r\nexit /b 7\r\n',
    );
    fs.writeFileSync(
      path.join(root, '停止工作台.cmd'),
      '@echo off\r\necho daily-stop\r\nexit /b 9\r\n',
    );
    for (const [file, args] of [
      ['start-hermes.cmd', ['start', '--headless']],
      ['integrations/hermes-workbench/start.cmd', ['--headless']],
      ['integrations/hermes-workbench/start-real.cmd', ['--headless']],
    ]) {
      const result = run(root, file, args);
      expect(result.status, result.stdout + result.stderr).toBe(7);
      expect(result.stdout).toContain('daily-start --headless');
    }
    const stopped = run(root, 'start-hermes.cmd', ['stop']);
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(9);
    expect(stopped.stdout).toContain('daily-stop');
    const help = run(root, 'start-hermes.cmd', ['help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('127.0.0.1:8057');
    expect(help.stdout).not.toContain('8047');
  },
);
it.runIf(process.platform === 'win32')(
  'reports missing daily runtime as failure without hanging on a pause',
  () => {
    const root = fixture();
    for (const file of ['启动工作台.cmd', '停止工作台.cmd']) {
      const result = run(root, file);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.status).not.toBeNull();
    }
  },
);
