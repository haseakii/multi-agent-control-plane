import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { terminalInvocationPrefix } from './terminal-auth.js';

it('keeps an extensionless Node ACP entry when replacing connection args for terminal login', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-auth-entry-'));
  try {
    const script = join(root, 'codebuddy');
    writeFileSync(script, '#!/usr/bin/env node\n// inert entry');
    const runtime = {
      type: 'acp-stdio' as const,
      command: process.execPath,
      args: [script, '--acp'],
    };
    expect(terminalInvocationPrefix(runtime)).toEqual([script]);
    writeFileSync(script, '#!/bin/sh\n');
    expect(terminalInvocationPrefix(runtime)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
