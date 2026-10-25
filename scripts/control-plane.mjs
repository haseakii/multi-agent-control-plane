import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  atomicJson,
  readJson,
  parseInstallation,
  validatePackage,
  upgradeInstallation,
  recoverInstallation,
  operationFile,
  parseOperation,
  inside,
} from './lib/installation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const nodeFor = (target) => path.join(target.releaseDir, 'runtime/node.exe');
const mainFor = (target) => path.join(target.releaseDir, 'apps/server/dist/release-main.js');
function argumentsFor(args) {
  const command = args[0] ?? 'start',
    flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--headless') {
      flags['--headless'] = true;
      continue;
    }
    if (
      ![
        '--installation',
        '--directory',
        '--release',
        '--config',
        '--connection',
        '--environment',
        '--operation',
      ].includes(args[i]) ||
      !args[i + 1] ||
      flags[args[i]] !== undefined
    )
      throw Error('无效参数。');
    flags[args[i]] = args[++i];
  }
  return { command, flags };
}
function configFor(target) {
  const raw = readJson(target.configFile);
  return {
    ...raw,
    dataDir: path.resolve(path.dirname(target.configFile), raw.dataDir ?? './data'),
    ...(raw.clientAccessFile
      ? { clientAccessFile: path.resolve(path.dirname(target.configFile), raw.clientAccessFile) }
      : {}),
  };
}
function httpJson(target, route) {
  const config = configFor(target);
  return new Promise((ok, no) => {
    const call = request(
      {
        hostname: '127.0.0.1',
        port: config.port ?? 3000,
        path: route,
        method: 'GET',
        agent: false,
      },
      (response) => {
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024 * 1024) call.destroy(Error('读取结果过大。'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw Error('工作台读取失败：' + response.statusCode);
            ok(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            no(error);
          }
        });
      },
    );
    call.setTimeout(5000, () => call.destroy(Error('工作台响应超时。')));
    call.on('error', no);
    call.end();
  });
}
async function ready(target, state) {
  try {
    const health = await httpJson(target, '/health');
    if (health.service !== 'multi-agent-control-plane' || health.status !== 'ok')
      throw Error('端口由其他服务占用。');
    if (health.deployment) {
      if (
        health.deployment.installationId !== state.id ||
        health.deployment.generationId !== target.generationId ||
        health.deployment.releaseId !== target.releaseId
      )
        throw Error('端口已有其它工作台实例，已保留原服务。');
    } else if (!target.legacy) throw Error('端口已有未绑定的工作台实例。');
    const expected = readJson(path.join(target.releaseDir, 'apps/web/dist/workbench.json'));
    const actual = await httpJson(target, '/api/workbench');
    if (actual.uiBuildId !== expected.uiBuildId) throw Error('工作台网页版本不一致。');
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return false;
    throw error;
  }
}
function run(target, args) {
  execFileSync(nodeFor(target), [mainFor(target), ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
function startDefinition(file, state, token) {
  const root = path.dirname(file),
    args = [
      path.join(root, 'launcher/control-plane.mjs'),
      'serve',
      '--installation',
      file,
      ...(token ? ['--operation', token] : []),
    ];
  return {
    command: state.runtimeFile,
    args,
    cwd: root,
    logFile: path.join(root, 'logs/startup.log'),
  };
}
async function launch(file, state, token) {
  const root = path.dirname(file);
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const startFile = path.join(root, token ? 'start-' + token + '.json' : 'engine-start.json');
  atomicJson(startFile, { start: startDefinition(file, state, token) });
  const helper = await import(
    pathToFileURL(
      path.join(
        state.current.releaseDir,
        'node_modules/@control-plane/fleet-mcp/dist/background-launch.js',
      ),
    ).href
  );
  await helper.launchBackgroundHost(startFile);
}
function continuity(snapshot) {
  const fields = [
    'projects',
    'tasks',
    'assignments',
    'executionAttempts',
    'messages',
    'approvals',
    'artifacts',
    'workspaces',
    'workspaceConfigs',
    'assignmentWorkspaces',
    'workspaceCleanups',
    'inputAttachments',
  ];
  const stable = Object.fromEntries(
    fields.map((key) => [
      key,
      (snapshot[key] ?? []).map((item) => {
        const copy = { ...item };
        delete copy.decisionEligibility;
        return copy;
      }),
    ]),
  );
  return digest(JSON.stringify(stable));
}
function operations(file) {
  const ensure = async (target, state, token) => {
    const guard = operationFile(file);
    if (fs.existsSync(guard) && readJson(guard).token !== token)
      throw Error('工作台正在升级或恢复，请稍后再试。');
    if (await ready(target, state)) return;
    await launch(file, { ...state, current: target }, token);
    for (let i = 0; i < 120; i++) {
      await delay(250);
      if (await ready(target, state)) return;
    }
    throw Error('后台启动未就绪，请查看安装目录 logs/startup.log。');
  };
  return {
    progress: (phase) =>
      console.log(
        {
          stopping: '正在正常停止旧版…',
          backup: '正在创建一致备份…',
          restoring: '正在新目录准备数据与附件…',
          starting: '正在启动新版…',
          verifying: '正在核对记录与权限…',
          committed: '升级验证完成。',
        }[phase] ?? phase,
      ),
    validate: async (directory) => {
      const pack = validatePackage(directory),
        versions = path.join(path.dirname(file), 'versions'),
        destination = path.join(versions, pack.releaseId);
      fs.mkdirSync(versions, { recursive: true });
      if (!fs.existsSync(destination)) {
        const staging = path.join(versions, '.incoming-' + randomUUID());
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, 'NOT-A-RELEASE'), 'Incomplete copy');
        fs.cpSync(pack.root, staging, { recursive: true, errorOnExist: true, force: false });
        validatePackage(staging, { copyInProgress: true });
        fs.unlinkSync(path.join(staging, 'NOT-A-RELEASE'));
        // Only a complete verified new directory receives the stable content address.
        // An interrupted copy remains separate, so selecting the package again can retry.
        if (!inside(versions, staging) || !inside(versions, destination))
          throw Error('Invalid version destination.');
        try {
          fs.renameSync(staging, destination);
        } catch (error) {
          if (!fs.existsSync(destination)) throw error;
        }
      } else if (fs.existsSync(path.join(destination, 'NOT-A-RELEASE')))
        throw Error('新版复制未完成，保留了原件，请先查看安装目录版本状态。');
      const installed = validatePackage(destination);
      if (installed.releaseId !== pack.releaseId) throw Error('已安装版本校验不一致。');
      return installed;
    },
    ensure,
    stop: async (target) => {
      run(target, ['stop', '--config', target.configFile]);
    },
    inspect: async (target) => {
      const snapshot = await httpJson(target, '/api/control-center');
      if (
        (snapshot.executionAttempts ?? []).some((attempt) =>
          ['running', 'waiting', 'queued'].includes(attempt.state),
        )
      )
        throw Error('还有任务正在执行或等待执行授权，完成或停止后再升级。');
      const policies = [];
      for (const project of snapshot.projects)
        policies.push([
          project.id,
          await httpJson(target, '/api/projects/' + encodeURIComponent(project.id) + '/policy'),
        ]);
      const config = configFor(target);
      return {
        digest: continuity(snapshot),
        policies,
        network: await httpJson(target, '/api/system/network'),
        access: config.clientAccessFile
          ? digest(fs.readFileSync(config.clientAccessFile))
          : undefined,
        inputs: (snapshot.inputAttachments ?? [])
          .flatMap((m) => m.attachments)
          .filter((a, i, list) => list.findIndex((b) => b.id === a.id) === i),
      };
    },
    backup: async (target, directory) => {
      run(target, ['backup', '--config', target.configFile, '--output', directory]);
    },
    restore: async (operation) => {
      run(operation.candidate, [
        'restore',
        '--backup',
        operation.backupDir,
        '--output',
        operation.restoreDir,
      ]);
      const original = configFor(operation.before),
        restored = readJson(operation.candidate.configFile);
      atomicJson(operation.candidate.configFile, {
        ...restored,
        port: original.port ?? 3000,
        ...(original.clientAccessFile ? { clientAccessFile: original.clientAccessFile } : {}),
      });
    },
    verify: async (target, state, before) => {
      if (!(await ready(target, state))) throw Error('新版健康检查未通过。');
      const after = await operations(file).inspect(target, state);
      for (const key of ['digest', 'policies', 'network', 'access'])
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          throw Error('升级后记录或权限不一致：' + key);
      for (const input of before.inputs) {
        const meta = await httpJson(target, '/api/input-attachments/' + input.id);
        if (meta.sha256 !== input.sha256 || meta.sizeBytes !== input.sizeBytes)
          throw Error('附件校验不一致。');
      }
    },
  };
}
function writeShortcuts(root) {
  for (const [name, command] of [
    ['启动工作台.cmd', 'start'],
    ['停止工作台.cmd', 'stop'],
    ['升级工作台.cmd', 'update'],
    ['恢复工作台.cmd', 'recover'],
    ['工作台状态.cmd', 'status'],
  ]) {
    fs.writeFileSync(
      path.join(root, name),
      [
        '@echo off',
        'setlocal',
        'chcp 65001 >nul',
        '"%~dp0runtime\\node.exe" "%~dp0launcher\\control-plane.mjs" ' + command + ' %*',
        'set "_CP_EXIT=%errorlevel%"',
        'if not "%_CP_EXIT%"=="0" if not defined CONTROL_PLANE_NO_PAUSE pause',
        'exit /b %_CP_EXIT%',
        '',
      ].join('\r\n'),
    );
  }
}
async function install(flags) {
  const source = path.resolve(flags['--release']),
    root = path.resolve(flags['--directory']),
    file = path.join(root, 'installation.json');
  if (fs.existsSync(file)) {
    parseInstallation(readJson(file));
    return { file, existing: true };
  }
  if (inside(source, root) || inside(root, source)) throw Error('安装目录与新版文件夹必须分开。');
  const pack = validatePackage(source, { legacy: !!flags['--config'] });
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw Error('请选择新的空安装目录。');
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.copyFileSync(path.join(source, 'runtime/node.exe'), path.join(root, 'runtime/node.exe'));
  fs.copyFileSync(path.join(source, 'runtime/LICENSE'), path.join(root, 'runtime/LICENSE'));
  fs.mkdirSync(path.join(root, 'launcher'));
  fs.copyFileSync(
    path.join(here, 'installed-entry.mjs'),
    path.join(root, 'launcher/control-plane.mjs'),
  );
  const versionDir = path.join(root, 'versions', pack.releaseId);
  fs.mkdirSync(path.dirname(versionDir), { recursive: true });
  fs.cpSync(pack.root, versionDir, { recursive: true, errorOnExist: true, force: false });
  if (!pack.manifest.files) {
    fs.mkdirSync(path.join(versionDir, 'launcher/lib'), { recursive: true });
    for (const name of ['control-plane.mjs', 'installed-entry.mjs'])
      fs.copyFileSync(path.join(here, name), path.join(versionDir, 'launcher', name));
    fs.copyFileSync(
      path.join(here, 'lib/installation.mjs'),
      path.join(versionDir, 'launcher/lib/installation.mjs'),
    );
  }
  let configFile = flags['--config']
    ? path.resolve(flags['--config'])
    : path.join(root, 'config.json');
  if (!flags['--config'])
    atomicJson(configFile, {
      ...readJson(path.join(source, 'config.json')),
      dataDir: path.join(root, 'data'),
    });
  const current = {
    releaseDir: versionDir,
    releaseId: pack.releaseId,
    configFile,
    generationId: randomUUID(),
    ...(!pack.manifest.files ? { legacy: true } : {}),
  };
  const state = parseInstallation({
    version: 1,
    id: randomUUID(),
    runtimeFile: path.join(root, 'runtime/node.exe'),
    current,
    environment: flags['--environment'] ? readJson(path.resolve(flags['--environment'])) : {},
    ...(flags['--connection'] ? { connectionFile: path.resolve(flags['--connection']) } : {}),
  });
  atomicJson(file, state);
  writeShortcuts(root);
  if (state.connectionFile) {
    const connection = readJson(state.connectionFile),
      before = JSON.stringify(connection);
    connection.start = startDefinition(file, state);
    const check = { ...connection, start: JSON.parse(before).start };
    if (JSON.stringify(check) !== before) throw Error('Unexpected connection change.');
    atomicJson(state.connectionFile, connection);
  }
  return { file, existing: false };
}
async function serve(file, state, token) {
  const record = operationFile(file);
  if (fs.existsSync(record) && readJson(record).token !== token)
    throw Error('维护中，未启动额外实例。');
  const target = state.current,
    root = path.dirname(file),
    temporary = path.join(root, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const context = {
    installationId: state.id,
    generationId: target.generationId,
    releaseId: target.releaseId,
    operationFile: record,
  };
  const child = spawn(nodeFor(target), [mainFor(target), '--config', target.configFile], {
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...state.environment,
      TEMP: temporary,
      TMP: temporary,
      CONTROL_PLANE_DEPLOYMENT_CONTEXT: JSON.stringify(context),
    },
  });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.on('SIGINT', () => {});
}
async function main() {
  const { command, flags } = argumentsFor(process.argv.slice(2));
  if (command === 'install' || command === 'open-package') {
    if (!flags['--release']) throw Error('请选择完整发布包。');
    flags['--directory'] ??= path.join(
      process.env.LOCALAPPDATA ?? path.dirname(path.resolve(flags['--release'])),
      'MultiAgentControlPlane',
    );
    const result = await install(flags);
    console.log('工作台安装入口已准备。');
    if (command === 'install') return;
    return start(result.file, true);
  }
  const file = path.resolve(flags['--installation'] ?? path.join(here, '../installation.json'));
  const state = parseInstallation(readJson(file)),
    ops = operations(file);
  if (command === 'serve') return serve(file, state, flags['--operation']);
  if (command === 'mcp') {
    const connection = path.resolve(flags['--connection'] ?? state.connectionFile ?? '');
    if (!fs.existsSync(connection)) throw Error('请选择已有授权的 MCP 连接文件。');
    const child = spawn(
      nodeFor(state.current),
      [
        path.join(
          state.current.releaseDir,
          'node_modules/@control-plane/fleet-mcp/dist/client-stdio-main.js',
        ),
        '--connection',
        connection,
      ],
      { windowsHide: true, stdio: 'inherit' },
    );
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    child.once('error', () => {
      process.exitCode = 1;
    });
    return;
  }
  if (command === 'start' || command === 'start-headless')
    return start(file, command === 'start' && !flags['--headless']);
  if (command === 'stop') {
    if (fs.existsSync(operationFile(file))) throw Error('维护正在进行，请先查看工作台状态。');
    await ops.stop(state.current, state);
    console.log('工作台已正常停止。');
    return;
  }
  if (command === 'recover') {
    const result = await recoverInstallation(file, ops);
    console.log(
      result.state === 'ready'
        ? '当前没有未完成的升级，无需恢复。'
        : '恢复已完成，工作台已在后台就绪。',
    );
    return;
  }
  if (command === 'status') {
    console.log(
      fs.existsSync(operationFile(file))
        ? '工作台正在升级或恢复，历史记录仍保留。'
        : (await ready(state.current, state))
          ? '工作台已在后台就绪。'
          : '工作台已停止，可双击“启动工作台”。',
    );
    console.log('当前版本：' + state.current.releaseId.slice(0, 12));
    return;
  }
  if (command === 'update') {
    let directory = flags['--release'];
    if (!directory) {
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      directory = execFileSync(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-STA',
          '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; $picker=New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description='请选择已解压的新版工作台文件夹'; $picker.ShowNewFolderButton=$false; if($picker.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Write($picker.SelectedPath)}",
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      if (!directory) {
        console.log('已取消升级。');
        return;
      }
    }
    const result = await upgradeInstallation(file, path.resolve(directory), ops);
    console.log(
      result.state === 'unchanged'
        ? '当前已是该版本，无需重复升级。'
        : '升级成功，工作台已在后台就绪；记录、附件和权限已核对。',
    );
    return;
  }
  throw Error('支持 start、start-headless、stop、status、update、recover、mcp。');
}
async function start(file, open) {
  const ops = operations(file);
  if (fs.existsSync(operationFile(file))) await recoverInstallation(file, ops);
  const state = parseInstallation(readJson(file));
  await ops.ensure(state.current, state);
  const url = 'http://127.0.0.1:' + (configFor(state.current).port ?? 3000) + '/';
  console.log('工作台已在后台就绪：' + url + '\n可以关闭本窗口。');
  if (open)
    spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'start', '""', url], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
