import { describe, expect, it } from 'vitest';
import { startupPortConflict, startupFailureDiagnostic } from './startup-diagnostic.js';

describe('startup port conflict diagnosis', () => {
  it('provides the configured port and recovery for an actual system error shape', () => {
    const error = Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' });
    const diagnostic = startupPortConflict(error, 12345)!;
    expect(diagnostic).toContain('12345 已被占用');
    expect(diagnostic).toContain('--config');
    expect(diagnostic).toContain('空闲端口');
  });

  it('does not mislabel permission, missing runtime or arbitrary textual errors as a port conflict', () => {
    for (const error of [
      null,
      'EADDRINUSE',
      new Error('EADDRINUSE'),
      { code: 'EACCES' },
      { code: 'ENOENT' },
    ])
      expect(startupPortConflict(error, 12345)).toBeUndefined();
  });

  it('does not invent a configured port when context is missing or invalid', () => {
    for (const port of [undefined, 0, 65536, 1.5, NaN, Infinity])
      expect(startupPortConflict({ code: 'EADDRINUSE' }, port)).toBeUndefined();
  });
});

describe('startup recovery classification', () => {
  it('gives data permission recovery without recommending privilege escalation', () => {
    expect(startupFailureDiagnostic({ code: 'EPERM' }, 12345, 'data')).toContain('dataDir');
    expect(startupFailureDiagnostic({ code: 'EACCES' }, 12345, 'config')).toContain('--config');
    expect(startupFailureDiagnostic({ code: 'EACCES' }, 12345, 'listen')).toContain(
      '本机端口监听被拒绝',
    );
  });
  it('keeps existing ownership fail closed and explains space failures', () => {
    expect(startupFailureDiagnostic({ code: 'INSTANCE_LOCKED' }, 12345, 'data')).toContain(
      '不要直接删除锁',
    );
    expect(startupFailureDiagnostic({ code: 'ENOSPC' }, 12345, 'data')).toContain('原生文件句柄');
    expect(startupFailureDiagnostic({ code: 'EIO' }, 12345, 'data')).toBeUndefined();
  });
});
