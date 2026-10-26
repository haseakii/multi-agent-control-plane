import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentDefinition, Workspace } from '@control-plane/core';
import { WorkspaceDirectoryBindingSchema } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import { z } from 'zod';
import { TaskControlError } from './task-control-error.js';
import { windowsSystemEnvironment } from './windows-system-environment.js';

const PathInput = z.string().min(1).max(4096);
export const DirectoryPreviewSchema = z.object({ path: PathInput }).strict();
export const ExistingDirectoryChoiceSchema = z
  .object({
    kind: z.literal('existing-local'),
    validationId: z.string().uuid(),
    confirmedPath: PathInput,
  })
  .strict();
type Identity = { rootPath: string; pathKey: string; deviceId: string; fileId: string };
type Preview = Identity & { requestedPath: string; expiresAt: number };
export type DirectoryInspectionOptions = {
  windowsMetadata?: (paths: string[]) => { driveType: string; reparsePoint: boolean };
};
function key(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const diff = relative(key(parent), key(child));
    return !diff || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith('..' + sep));
  };
  return inside(a, b) || inside(b, a);
}
function windowsMetadataCommand(paths: string[]) {
  // Constant script and data-only environment: no interpolation or execution-policy changes.
  const command =
    "$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json $env:CONTROL_PLANE_DIRECTORY_PATHS; $drive=([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($paths[0]))).DriveType.ToString(); $reparse=$false; if($drive -eq 'Fixed'){foreach($p in $paths){if(([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){$reparse=$true}}}; @{driveType=$drive;reparsePoint=$reparse}|ConvertTo-Json -Compress";
  return {
    file: resolve(
      process.env.SystemRoot ?? 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    options: {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
      encoding: 'utf8' as const,
      env: {
        ...windowsSystemEnvironment(),
        SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
        CONTROL_PLANE_DIRECTORY_PATHS: JSON.stringify(paths),
      },
    },
  };
}
function windowsMetadata(paths: string[]) {
  const { file, args, options } = windowsMetadataCommand(paths);
  return JSON.parse(
    execFileSync(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
  ) as { driveType: string; reparsePoint: boolean };
}
async function windowsMetadataAsync(paths: string[]) {
  const { file, args, options } = windowsMetadataCommand(paths);
  const { stdout } = await promisify(execFile)(file, args, options);
  return JSON.parse(stdout) as { driveType: string; reparsePoint: boolean };
}

/** Metadata only: never lists directory contents, invokes Git, writes or grants access. */
export class LocalDirectoryBindings {
  private readonly previews = new Map<string, Preview>();
  private readonly confirmationEpoch = randomUUID();
  private readonly liveInspections = new Map<string, Promise<void>>();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly protectedRoots: string[],
    private readonly inspection: DirectoryInspectionOptions = {},
  ) {}

  inspect(input: string): Identity {
    return this.inspectWithMetadata(input);
  }
  private inspectWithMetadata(
    input: string,
    metadataOverride?: { driveType: string; reparsePoint: boolean },
  ): Identity {
    if (process.platform !== 'win32')
      throw new TaskControlError(
        400,
        'B0 existing-directory binding currently supports Windows local fixed disks only. Managed workspaces remain available.',
      );
    if (
      !input ||
      input !== input.trim() ||
      /[\0-\x1f*?"<>|]/.test(input) ||
      !isAbsolute(input) ||
      (process.platform === 'win32' &&
        (!/^[a-z]:[\\/]/i.test(input) || input.slice(2).includes(':'))) ||
      input
        .split(/[\\/]/)
        .some(
          (part) =>
            part === '..' || part === '.' || /^(?:\.codex|\.aws|\.ssh|\.gnupg|\.kube)$/i.test(part),
        )
    )
      throw new TaskControlError(
        400,
        'Use an explicit absolute local directory; relative, device, network, credential and ambiguous paths are unsupported.',
      );
    const requested = resolve(input);
    if (
      requested === parse(requested).root ||
      key(requested) ===
        key(resolve(process.env.USERPROFILE ?? process.env.HOME ?? parse(requested).root))
    )
      throw new TaskControlError(400, 'Drive and user-home roots cannot be bound.');
    const paths: string[] = [];
    for (let p = requested; ; p = dirname(p)) {
      paths.push(p);
      if (dirname(p) === p) break;
      if (paths.length > 128)
        throw new TaskControlError(400, 'Directory nesting exceeds the binding limit.');
    }
    try {
      if (process.platform === 'win32') {
        const metadata =
          metadataOverride ?? (this.inspection.windowsMetadata ?? windowsMetadata)(paths);
        if (metadata.driveType !== 'Fixed' || metadata.reparsePoint)
          throw new Error('Unsupported volume or reparse point');
      }
      for (const p of paths)
        if (lstatSync(p).isSymbolicLink()) throw new Error('Links are unsupported');
      const rootPath = realpathSync.native(requested);
      const home = process.env.USERPROFILE ?? process.env.HOME;
      if (
        key(rootPath) === key(parse(rootPath).root) ||
        (home && key(rootPath) === key(realpathSync.native(home))) ||
        rootPath
          .split(/[\\/]/)
          .some((part) => /^(?:\.codex|\.aws|\.ssh|\.gnupg|\.kube)$/i.test(part))
      )
        throw new Error('Canonical home, drive or credential path is unsupported');
      const stat = statSync(rootPath, { bigint: true });
      if (!stat.isDirectory() || stat.ino === 0n) throw new Error('Not a stable directory');
      accessSync(rootPath, constants.R_OK);
      for (const protectedRoot of this.protectedRoots) {
        // Resolve existing ancestors too: a missing child must not preserve an 8.3 alias.
        const suffix: string[] = [];
        let ancestor = resolve(protectedRoot);
        let canonical: string;
        for (;;) {
          try {
            canonical = resolve(realpathSync.native(ancestor), ...suffix);
            break;
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
              dirname(ancestor) === ancestor
            )
              throw error;
            suffix.unshift(basename(ancestor));
            ancestor = dirname(ancestor);
          }
        }
        if (overlaps(rootPath, canonical)) throw new Error('Protected runtime path');
      }
      return {
        rootPath,
        pathKey: key(rootPath),
        deviceId: String(stat.dev),
        fileId: String(stat.ino),
      };
    } catch {
      throw new TaskControlError(
        400,
        'Directory is missing, not a supported readable local directory, linked, or overlaps private runtime/install data. No contents were read or changed.',
      );
    }
  }
  private available(identity: Identity) {
    for (const binding of this.storage.repositories.workspaceDirectoryBindings.list()) {
      if (
        overlaps(binding.rootPath, identity.rootPath) ||
        (binding.deviceId === identity.deviceId && binding.fileId === identity.fileId)
      )
        throw new TaskControlError(
          409,
          'This directory or an overlapping alias is already bound to a project.',
        );
    }
  }
  preview(input: unknown) {
    const { path } = DirectoryPreviewSchema.parse(input);
    const identity = this.inspect(path);
    this.available(identity);
    const now = Date.now();
    for (const [id, item] of this.previews) if (item.expiresAt <= now) this.previews.delete(id);
    if (this.previews.size >= 64)
      throw new TaskControlError(429, 'Too many pending directory validations; wait for expiry.');
    const validationId = randomUUID(),
      expiresAt = now + 5 * 60_000;
    this.previews.set(validationId, { ...identity, requestedPath: path, expiresAt });
    return {
      validationId,
      rootPath: identity.rootPath,
      expiresAt: new Date(expiresAt).toISOString(),
      notice:
        '仅关联目录；不复制、扫描或启动 Agent。提交目标可能读取/修改该目录；LocalRunner 不是 OS 沙箱。',
    };
  }
  confirm(choice: z.infer<typeof ExistingDirectoryChoiceSchema>): Identity {
    const previous = this.previews.get(choice.validationId);
    if (!previous || previous.expiresAt <= Date.now() || choice.confirmedPath !== previous.rootPath)
      throw new TaskControlError(409, 'Validate and confirm the displayed actual directory again.');
    const current = this.inspect(previous.requestedPath);
    if (
      JSON.stringify(current) !==
      JSON.stringify({
        rootPath: previous.rootPath,
        pathKey: previous.pathKey,
        deviceId: previous.deviceId,
        fileId: previous.fileId,
      })
    )
      throw new TaskControlError(409, 'Directory identity changed; validate again.');
    this.available(current);
    return current;
  }
  persist(workspace: Workspace, identity: Identity, validationId: string) {
    this.storage.repositories.workspaceDirectoryBindings.upsert(
      WorkspaceDirectoryBindingSchema.parse({
        id: workspace.id,
        projectId: workspace.projectId,
        ...identity,
        createdAt: new Date().toISOString(),
      }),
    );
    this.previews.delete(validationId);
  }
  validateExecution(workspace: Workspace, agent: AgentDefinition) {
    this.validateIdentity(workspace);
    const binding = this.storage.repositories.workspaceDirectoryBindings.get(workspace.id);
    if (!binding || !agent.runtime.cwd) return;
    let configured: Identity;
    try {
      configured = this.inspect(agent.runtime.cwd);
    } catch {
      throw new TaskControlError(
        409,
        'Agent cwd conflicts with the bound project directory or is unsupported.',
      );
    }
    if (configured.deviceId !== binding.deviceId || configured.fileId !== binding.fileId)
      throw new TaskControlError(
        409,
        'Agent cwd conflicts with the bound project directory. Omit it or choose this exact directory explicitly.',
      );
  }
  validateIdentity(workspace: Workspace) {
    const binding = this.storage.repositories.workspaceDirectoryBindings.get(workspace.id);
    if (!binding) return;
    const current = this.inspect(binding.rootPath);
    this.assertIdentity(workspace, binding, current);
  }
  /** Same admission checks without blocking HTTP sockets; concurrent reads share only an in-flight probe. */
  async validateIdentityAsync(workspace: Workspace): Promise<void> {
    const binding = this.storage.repositories.workspaceDirectoryBindings.get(workspace.id);
    if (!binding) return;
    const inspectionKey = JSON.stringify([workspace, binding]);
    const existing = this.liveInspections.get(inspectionKey);
    if (existing) return existing;
    const pending = (async () => {
      const paths: string[] = [];
      for (let p = resolve(binding.rootPath); ; p = dirname(p)) {
        paths.push(p);
        if (dirname(p) === p) break;
      }
      const metadata = this.inspection.windowsMetadata
        ? this.inspection.windowsMetadata(paths)
        : await windowsMetadataAsync(paths);
      const current = this.inspectWithMetadata(binding.rootPath, metadata);
      const latest = this.storage.repositories.workspaceDirectoryBindings.get(workspace.id);
      if (JSON.stringify(latest) !== JSON.stringify(binding))
        throw new TaskControlError(409, 'Directory binding changed during validation.');
      this.assertIdentity(workspace, binding, current);
    })();
    this.liveInspections.set(inspectionKey, pending);
    try {
      await pending;
    } finally {
      this.liveInspections.delete(inspectionKey);
    }
  }
  private assertIdentity(
    workspace: Workspace,
    binding: z.infer<typeof WorkspaceDirectoryBindingSchema>,
    current: Identity,
  ) {
    if (
      workspace.projectId !== binding.projectId ||
      workspace.rootPath !== binding.rootPath ||
      current.pathKey !== binding.pathKey ||
      current.deviceId !== binding.deviceId ||
      current.fileId !== binding.fileId
    )
      throw new TaskControlError(
        409,
        'Bound directory changed or is unavailable; recheck it before execution.',
      );
  }
  confirmationVersion(id: string): string {
    const binding = this.storage.repositories.workspaceDirectoryBindings.get(id);
    if (!binding) throw new TaskControlError(404, 'Directory binding is unavailable.');
    return createHash('sha256')
      .update(JSON.stringify([this.confirmationEpoch, binding]))
      .digest('hex');
  }
  /** Explicit MCP project grants survive engine restarts, but not directory replacement. */
  persistentConfirmationVersion(id: string): string {
    const binding = this.storage.repositories.workspaceDirectoryBindings.get(id);
    if (!binding) throw new TaskControlError(404, 'Directory binding is unavailable.');
    return createHash('sha256')
      .update(
        JSON.stringify([
          'client-workspace-v1',
          binding.id,
          binding.rootPath,
          binding.deviceId,
          binding.fileId,
        ]),
      )
      .digest('hex');
  }
  requireGoalConfirmation(
    workspace: Workspace,
    confirmation?: { workspaceId: string; rootPath: string; version: string },
  ) {
    if (
      this.storage.repositories.workspaceDirectoryBindings.get(workspace.id) &&
      (!confirmation ||
        confirmation.workspaceId !== workspace.id ||
        confirmation.rootPath !== workspace.rootPath ||
        confirmation.version !== this.confirmationVersion(workspace.id))
    )
      throw new TaskControlError(
        409,
        'Confirm the displayed bound workspace and its execution impact before submitting a goal.',
      );
  }
}
