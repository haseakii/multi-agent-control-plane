import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AgentDefinitionSchema, type AgentDefinition } from '@control-plane/core';
import { inspectAgentConfiguration } from './agent-diagnostics.js';

const args = process.argv.slice(2);
const usage =
  'Usage: pnpm prepare:collaboration --boss BOSS_JSON --worker WORKER_JSON --output NEW_REPORT_JSON. Offline only; never registers, probes, authenticates or prompts Agents.';
if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
  console.log(usage);
} else if (
  args.length !== 6 ||
  args[0] !== '--boss' ||
  args[2] !== '--worker' ||
  args[4] !== '--output'
) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const inputs = [args[1]!, args[3]!].map((filename) => {
      const text = readFileSync(filename, 'utf8');
      return {
        configurationHash: createHash('sha256').update(text).digest('hex'),
        agent: AgentDefinitionSchema.parse(JSON.parse(text) as unknown),
      };
    });
    const boss = inputs[0]!.agent,
      worker = inputs[1]!.agent;
    const issues: Array<{ code: string; role?: 'boss' | 'worker'; message: string }> = [];
    if (boss.id === worker.id)
      issues.push({
        code: 'DISTINCT_AGENT_IDS_REQUIRED',
        message: 'Select two distinct Agent registrations.',
      });
    if (
      boss.runtime.command === worker.runtime.command &&
      JSON.stringify(boss.runtime.args) === JSON.stringify(worker.runtime.args)
    )
      issues.push({
        code: 'DISTINCT_ENTRIES_NOT_ESTABLISHED',
        message:
          'Both selected configurations use the same executable and arguments; independent external Agent selection is not established.',
      });
    const actors = inputs.map(({ agent, configurationHash }, index) => {
      const role = index === 0 ? ('boss' as const) : ('worker' as const);
      const inspection = inspectAgentConfiguration(agent, { localOnly: true });
      for (const issue of inspection.issues) issues.push({ ...issue, role });
      if (!agent.enabled)
        issues.push({
          code: 'AGENT_DISABLED',
          role,
          message:
            'Enable this Agent explicitly in the isolated acceptance registry before execution.',
        });
      if (agent.auth.mode !== 'agent-managed')
        issues.push({
          code: 'AGENT_MANAGED_AUTH_REQUIRED',
          role,
          message: 'This acceptance preparation expects Agent-managed authentication.',
        });
      if (agent.runtime.cwd)
        issues.push({
          code: 'OMIT_FIXED_CWD',
          role,
          message:
            'Omit Agent-level cwd so the isolated acceptance project controls assignment workspaces.',
        });
      if (!agent.capabilities.length)
        issues.push({
          code: 'CAPABILITIES_REQUIRED',
          role,
          message: 'Configure capability metadata for discovery during acceptance.',
        });
      return {
        role,
        configurationHash,
        enabled: agent.enabled,
        capabilityCount: agent.capabilities.length,
        bridgeScopes: agent.controlBridge.scopes,
        inspection,
      };
    });
    const hasScope = (agent: AgentDefinition, scope: string) =>
      agent.controlBridge.transport === 'mcp' &&
      agent.controlBridge.scopes.some((item) => item === scope);
    if (!boss.orchestration.canBeBoss || !hasScope(boss, 'boss.orchestration'))
      issues.push({
        code: 'BOSS_CONFIGURATION_REQUIRED',
        role: 'boss',
        message: 'Boss eligibility and MCP orchestration scope are both required.',
      });
    if (!hasScope(boss, 'artifact.read'))
      issues.push({
        code: 'BOSS_RESULT_READ_REQUIRED',
        role: 'boss',
        message: 'Grant artifact.read so the Boss can read the Worker result for final synthesis.',
      });
    const report = {
      version: 1,
      kind: 'offline-two-agent-acceptance-preparation',
      preparedAt: new Date().toISOString(),
      configurationChecksPassed: issues.length === 0,
      readyToExecute: false,
      runtime: 'not_started',
      authentication: 'not_checked',
      model: 'not_requested',
      externalAgentIndependence: 'not_verified',
      actors,
      issues,
      plannedHostPromptTurns: [
        'Boss discovers and delegates one task',
        'Worker executes and returns a durable result',
        'Boss receives the result and produces a final response',
      ],
      budget: {
        approval: 'required-before-real-execution',
        plannedAcpPromptTurns: 3,
        enforcedByThisTool: false,
        providerRequestCount: 'opaque-and-not-guaranteed',
      },
      acceptanceEvidenceRequired: [
        'Explicitly selected independent external ACP Agents with their own authorization',
        'A fresh isolated project, data directory and workspace',
        'Successful scoped discovery and delegation by the selected Boss',
        'Independent Worker ACP session, completed assignment and durable result artifact',
        'Routed completion, Boss continuation and final artifact',
        'Restart preserves task/message/event history without replaying completed work',
      ],
    };
    // Exclusive creation avoids replacing another run's preparation or evidence.
    writeFileSync(args[5]!, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(
      JSON.stringify({
        configurationChecksPassed: report.configurationChecksPassed,
        issueCodes: issues.map((issue) => issue.code),
        runtime: report.runtime,
        model: report.model,
      }),
    );
    process.exitCode = report.configurationChecksPassed ? 0 : 1;
  } catch {
    // Never echo paths, raw config, arguments, environment values or parser details.
    console.error(
      JSON.stringify({
        code: 'PREPARATION_FAILED',
        message:
          'Cannot read/validate selected configurations or create the new report. No Agent was started.',
      }),
    );
    process.exitCode = 1;
  }
}
