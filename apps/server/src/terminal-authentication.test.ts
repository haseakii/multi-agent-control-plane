import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { expect, it } from 'vitest';
import { AgentDefinitionSchema } from '@control-plane/core';
import { ProcessAgentRuntimeControl } from '@control-plane/acp-runtime';
import { LocalRunner } from '@control-plane/runner';
import { windowsTerminalAuthentication } from './terminal-authentication.js';
import { managedAgentRuntime } from './agent-launcher.js';

it.skipIf(process.platform !== 'win32')(
  'runs the advertised terminal login with its real interpreter and never reports a failed login as ready',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-terminal-'));
    const runner = new LocalRunner({ defaultStopGracePeriodMs: 100 });
    const control = new ProcessAgentRuntimeControl(runner, {
      authenticationTimeoutMs: 15000,
      terminalAuthentication: windowsTerminalAuthentication(runner, { windowStyle: 'Hidden' }),
    });
    try {
      for (const failed of [false, true]) {
        const marker = join(root, failed ? '未完成.json' : '中文 登录.json');
        const args = [
          resolve('packages/acp-runtime/fixtures/auth-agent.mjs'),
          '--terminal-auth',
          marker,
          ...(failed ? ['--fail-terminal'] : []),
        ];
        const definition = AgentDefinitionSchema.parse({
          id: 'terminal',
          name: 'Terminal fixture',
          enabled: true,
          runtime: failed
            ? { type: 'acp-stdio', command: process.execPath, args }
            : managedAgentRuntime({
                directory: root,
                command: process.execPath,
                prefixArgs: [args[0]!],
                args: args.slice(1),
                environment: { ACP_TEST_LOGIN: 'catalog-default' },
              }),
          auth: { mode: 'agent-managed' },
          capabilities: [],
          orchestration: { canBeBoss: false },
          controlBridge: { transport: 'none', scopes: [] },
        });
        const observation = await control.probe(definition);
        expect(observation.authMethods).toEqual([
          { id: 'terminal-login', name: 'Terminal login', type: 'terminal' },
        ]);
        expect(JSON.stringify(observation)).not.toContain(marker);
        expect(JSON.stringify(observation)).not.toContain('owned-by-agent');
        expect(existsSync(marker)).toBe(false);
        if (!failed) {
          await expect(
            control.authenticate(definition, 'terminal-login', { interactive: false }),
          ).rejects.toThrow('后台预热不会自动打开登录终端');
          expect(existsSync(marker)).toBe(false);
        }
        if (failed) {
          await expect(control.authenticate(definition, 'terminal-login')).rejects.toThrow(
            '终端登录未完成',
          );
          expect(existsSync(marker)).toBe(false);
        } else {
          expect((await control.authenticate(definition, 'terminal-login')).readiness.auth).toBe(
            'ready',
          );
          const receipt = JSON.parse(readFileSync(marker, 'utf8'));
          expect(receipt.value).toBe('owned-by-agent');
          expect(receipt.args).toEqual(['--terminal-login', marker]);
          expect(receipt.tty).toBe(true);
        }
      }
      const marker = join(root, 'cancelled-login.json');
      const definition = AgentDefinitionSchema.parse({
        id: 'terminal-cancel',
        name: 'Cancelled terminal fixture',
        enabled: true,
        runtime: {
          type: 'acp-stdio',
          command: process.execPath,
          args: [
            resolve('packages/acp-runtime/fixtures/auth-agent.mjs'),
            '--terminal-auth',
            marker,
            '--hang-terminal',
          ],
        },
        auth: { mode: 'agent-managed' },
        capabilities: [],
        orchestration: { canBeBoss: false },
        controlBridge: { transport: 'none', scopes: [] },
      });
      const pending = control.authenticate(definition, 'terminal-login').then(
        () => 'unexpected-ready',
        (error: unknown) => (error instanceof Error ? error.message : 'failed'),
      );
      await expect.poll(() => existsSync(marker), { timeout: 8000 }).toBe(true);
      const pid = JSON.parse(readFileSync(marker, 'utf8')).pid as number;
      control.close();
      expect(await pending).not.toBe('unexpected-ready');
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5000 },
        )
        .toBe(false);
    } finally {
      control.close();
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
      expect(basename(root)).toMatch(/^acp-terminal-/);
      rmSync(root, { recursive: true, force: true });
    }
  },
  40000,
);
