import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { AgentDefinitionSchema } from '@control-plane/core';
import { windowsWrapperIssue } from './windows-command.js';

type Issue = { code: string; message: string };
type InspectionOptions = {
  platform?: NodeJS.Platform;
  isFile?: (filename: string) => boolean;
};

function isFile(filename: string): boolean {
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

/** Inspect one explicitly supplied config and path metadata; never execute or resolve auth. */
export function inspectAgentConfiguration(input: unknown, options: InspectionOptions = {}) {
  const parsed = AgentDefinitionSchema.safeParse(input);
  const issues: Issue[] = [];
  if (!parsed.success) {
    issues.push({
      code: 'CONFIG_INVALID',
      message: 'Configuration does not match AgentDefinitionSchema.',
    });
  } else {
    const { runtime } = parsed.data;
    const platform = options.platform ?? process.platform;
    const paths = platform === 'win32' ? win32 : posix;
    const checkFile = options.isFile ?? isFile;
    const wrapper = windowsWrapperIssue(runtime.command, platform);
    if (wrapper) issues.push({ code: 'WINDOWS_WRAPPER_UNSUPPORTED', message: wrapper });
    if (!paths.isAbsolute(runtime.command)) {
      issues.push({
        code: 'COMMAND_NOT_ABSOLUTE',
        message: 'Use an absolute executable path; PATH is not searched by this diagnosis.',
      });
    } else if (!checkFile(runtime.command)) {
      issues.push({
        code: 'COMMAND_NOT_FILE',
        message: 'Executable path is missing or is not a regular file.',
      });
    }
    if (/^node(?:\.exe)?$/i.test(paths.basename(runtime.command))) {
      const entry = runtime.args[0];
      if (!entry || !paths.isAbsolute(entry) || !/\.(?:c|m)?js$/i.test(entry)) {
        issues.push({
          code: 'NODE_ENTRY_REQUIRED',
          message:
            'For this Node adapter example, args[0] must be an absolute .js/.mjs/.cjs entrypoint.',
        });
      } else if (!checkFile(entry)) {
        issues.push({
          code: 'NODE_ENTRY_NOT_FILE',
          message: 'Node adapter entrypoint is missing or is not a regular file.',
        });
      }
    }
    if (runtime.cwd && !paths.isAbsolute(runtime.cwd)) {
      issues.push({
        code: 'CWD_NOT_ABSOLUTE',
        message: 'Use an absolute cwd, or omit it to use the project workspace.',
      });
    }
  }
  return {
    configurationValid: parsed.success,
    enabled: parsed.success ? parsed.data.enabled : null,
    offlineChecksPassed: issues.length === 0,
    issues,
    runtime: 'not_started' as const,
    authentication: 'not_checked' as const,
    model: 'not_requested' as const,
  };
}
