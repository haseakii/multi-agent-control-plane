import { win32 } from 'node:path';

export function windowsWrapperIssue(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (
    platform === 'win32' &&
    ['.cmd', '.bat', '.ps1'].includes(win32.extname(command.trim()).toLowerCase())
  ) {
    return 'Windows .cmd/.bat/.ps1 wrappers cannot run with shell:false. Use the underlying executable, for example an absolute node.exe command with the adapter JavaScript entrypoint in args.';
  }
  return undefined;
}
