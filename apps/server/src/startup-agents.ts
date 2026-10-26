import { setTimeout as delay } from 'node:timers/promises';
import { AgentControlError, type AgentControlService } from './agent-control.js';

/** Startup is independent of HTTP readiness. Retry one transient failure, never a rejected login. */
export async function warmStartupAgents(
  agents: readonly { agentId: string; authMethodId: string }[],
  control: Pick<AgentControlService, 'warmAuthentication'>,
  options: {
    signal: AbortSignal;
    report: (id: string, state: 'ready' | 'retrying' | 'unavailable') => void;
    wait?: () => Promise<void>;
  },
): Promise<void> {
  await Promise.all(
    agents.map(async ({ agentId, authMethodId }) => {
      for (let attempt = 0; attempt < 2 && !options.signal.aborted; attempt++) {
        try {
          const state = await control.warmAuthentication(agentId, authMethodId);
          if (!options.signal.aborted)
            options.report(agentId, state.readiness.auth === 'ready' ? 'ready' : 'unavailable');
          return;
        } catch (error) {
          if (options.signal.aborted) return;
          if (
            attempt === 0 &&
            error instanceof AgentControlError &&
            ['authentication_unavailable', 'timeout', 'exited'].includes(error.code ?? '')
          ) {
            options.report(agentId, 'retrying');
            try {
              await (options.wait?.() ?? delay(1000, undefined, { signal: options.signal }));
            } catch {
              return;
            }
            continue;
          }
          options.report(agentId, 'unavailable');
          return;
        }
      }
    }),
  );
}
