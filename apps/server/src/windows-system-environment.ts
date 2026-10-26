import { tmpdir } from 'node:os';

/** Windows/.NET startup needs the user/system directory and module-cache context.
 * Copy only OS setup variables; never inherit provider credentials or arbitrary flags.
 */
export function windowsSystemEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const allowed = new Map(
    [
      'SystemRoot',
      'SystemDrive',
      'WINDIR',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'TEMP',
      'TMP',
      'PATH',
      'ComSpec',
      'PATHEXT',
      'PSModulePath',
      'PSModuleAnalysisCachePath',
    ].map((key) => [key.toLowerCase(), key]),
  );
  const result = Object.fromEntries(
    Object.entries(environment)
      .filter(
        (entry): entry is [string, string] =>
          allowed.has(entry[0].toLowerCase()) && typeof entry[1] === 'string',
      )
      .map(([key, value]) => [allowed.get(key.toLowerCase())!, value]),
  );
  result.SystemRoot ??= 'C:/Windows';
  result.TEMP ??= tmpdir();
  result.TMP ??= result.TEMP;
  return result;
}
