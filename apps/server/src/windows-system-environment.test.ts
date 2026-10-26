import { expect, it } from 'vitest';
import { windowsSystemEnvironment } from './windows-system-environment.js';

it('keeps Windows startup/cache locations without forwarding credentials or runtime injection flags', () => {
  expect(
    windowsSystemEnvironment({
      SystemRoot: 'C:/Windows',
      USERPROFILE: 'C:/Users/fixture',
      LOCALAPPDATA: 'C:/Users/fixture/AppData/Local',
      TEMP: 'C:/Temp',
      TMP: 'C:/Temp',
      Path: 'C:/Windows/System32',
      PSModulePath: 'C:/Windows/modules',
      PROVIDER_API_KEY: 'do-not-copy',
      NODE_OPTIONS: '--require unsafe',
      CP_PRIVATE_TOKEN: 'do-not-copy',
    }),
  ).toEqual({
    SystemRoot: 'C:/Windows',
    USERPROFILE: 'C:/Users/fixture',
    LOCALAPPDATA: 'C:/Users/fixture/AppData/Local',
    TEMP: 'C:/Temp',
    TMP: 'C:/Temp',
    PATH: 'C:/Windows/System32',
    PSModulePath: 'C:/Windows/modules',
  });
});

it('normalizes Windows environment key casing before applying defaults', () => {
  expect(
    windowsSystemEnvironment({
      systemroot: 'D:/Windows',
      temp: 'D:/Temp',
      tmp: 'D:/Temp',
      path: 'D:/Windows/System32',
    }),
  ).toEqual({
    SystemRoot: 'D:/Windows',
    TEMP: 'D:/Temp',
    TMP: 'D:/Temp',
    PATH: 'D:/Windows/System32',
  });
});
