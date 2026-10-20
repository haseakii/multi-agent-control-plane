import { StrictMode, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type AuthMethod = { id: string; name: string; type?: string };

type Snapshot = {
  generatedAt: string;
  projects: Array<{ id: string; name: string; defaultBossAgentId?: string }>;
  agents: Array<{
    definition: {
      id: string;
      name: string;
      enabled: boolean;
      runtime: { command: string; args: string[]; cwd?: string; environmentAllowlist?: string[] };
      orchestration: { canBeBoss: boolean };
      controlBridge: { transport: string; scopes: string[] };
      capabilities: Array<{ name: string; source: string }>;
    };
    readiness: { runtime: string; auth: string };
    authMethods: AuthMethod[];
    error?: string;
  }>;
  tasks: Array<{ id: string; title: string; state: string; ownerAgentId?: string }>;
  timeline: Array<{ id: string; type: string; occurredAt: string; actor: { id: string } }>;
  messages: Array<{
    id: string;
    fromAgentId: string;
    toAgentId?: string;
    type: string;
    content?: string;
    createdAt: string;
  }>;
  approvals: Array<{ id: string; action: string; state: string; enforcementMode: string }>;
  artifacts: Array<{ id: string; kind: string; producerAgentId?: string; sizeBytes: number }>;
  runners: Array<{ id: string; kind: string; status: string }>;
  workspaces: Array<{ id: string; provider: string; access: string }>;
};

type AgentForm = {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd: string;
  environmentAllowlist: string;
  capabilities: string;
  canBeBoss: boolean;
};

const emptyAgentForm: AgentForm = {
  id: '',
  name: '',
  command: '',
  args: '',
  cwd: '',
  environmentAllowlist: '',
  capabilities: '',
  canBeBoss: false,
};

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}

function Empty({ children }: { children: string }) {
  return <p className="empty">{children}</p>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { 'content-type': 'application/json', ...(init.headers ?? {}) }
      : init?.headers,
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with HTTP ${response.status}`);
  }
  return payload;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentForm>(emptyAgentForm);

  const loadSnapshot = async () => {
    const value = await api<Snapshot>('/api/control-center');
    setSnapshot(value);
    setError(null);
  };

  useEffect(() => {
    let active = true;
    api<Snapshot>('/api/control-center')
      .then((value) => {
        if (active) {
          setSnapshot(value);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const project = snapshot?.projects[0];
  const boss = useMemo(
    () => snapshot?.agents.find((agent) => agent.definition.id === project?.defaultBossAgentId),
    [project?.defaultBossAgentId, snapshot?.agents],
  );
  const bossCandidates =
    snapshot?.agents.filter(
      (agent) =>
        agent.definition.enabled &&
        agent.definition.orchestration.canBeBoss &&
        agent.definition.controlBridge.transport === 'mcp' &&
        agent.definition.controlBridge.scopes.includes('boss.orchestration'),
    ) ?? [];

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await action();
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const registerAgent = async (event: FormEvent) => {
    event.preventDefault();
    await runAction('register', async () => {
      const capabilities = agentForm.capabilities
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((name) => ({ name, source: 'configured' }));
      const args = agentForm.args
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      const environmentAllowlist = agentForm.environmentAllowlist
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          id: agentForm.id.trim(),
          name: agentForm.name.trim(),
          enabled: true,
          runtime: {
            type: 'acp-stdio',
            command: agentForm.command.trim(),
            args,
            ...(agentForm.cwd.trim() ? { cwd: agentForm.cwd.trim() } : {}),
            ...(environmentAllowlist.length > 0 ? { environmentAllowlist } : {}),
          },
          capabilities,
          auth: { mode: 'agent-managed' },
          orchestration: { canBeBoss: agentForm.canBeBoss },
          controlBridge: agentForm.canBeBoss
            ? {
                transport: 'mcp',
                scopes: [
                  'boss.orchestration',
                  'agent.messaging',
                  'artifact.read',
                  'artifact.publish',
                  'task.status',
                ],
              }
            : { transport: 'none', scopes: [] },
        }),
      });
      setAgentForm(emptyAgentForm);
      setNotice('Agent registered. Probe it to inspect ACP readiness and authentication.');
    });
  };

  const probe = (agentId: string) =>
    runAction(`probe:${agentId}`, async () => {
      await api(`/api/agents/${encodeURIComponent(agentId)}/probe`, { method: 'POST' });
      setNotice(`Probed ${agentId}.`);
    });

  const authenticate = (agentId: string, methodId: string) =>
    runAction(`auth:${agentId}`, async () => {
      await api(`/api/agents/${encodeURIComponent(agentId)}/auth`, {
        method: 'POST',
        body: JSON.stringify({ methodId }),
      });
      setNotice(`Authentication action completed for ${agentId}.`);
    });

  const selectBoss = (agentId: string) => {
    if (!project) {
      return Promise.resolve();
    }
    return runAction('boss', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}/boss`, {
        method: 'PUT',
        body: JSON.stringify({ agentId }),
      });
      setNotice(`Selected ${agentId} as Boss for ${project.name}.`);
    });
  };

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL-FIRST · V0 CONTROL CENTER</p>
          <h1>Multi-Agent Control Plane</h1>
          <p className="intro">
            Register arbitrary ACP agents, authorize them independently, select an eligible Boss,
            and observe durable orchestration without fixed vendor roles.
          </p>
        </div>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          {error ? 'Control plane needs attention' : snapshot ? 'Control plane online' : 'Connecting…'}
        </div>
      </header>

      {error ? <div className="error-card">{error}</div> : null}
      {notice ? <div className="notice-card">{notice}</div> : null}

      <section className="summary-grid" aria-label="Control plane summary">
        <article className="summary-card">
          <span>Project</span>
          <strong>{project?.name ?? '—'}</strong>
          <small>{project?.id ?? 'No active project'}</small>
        </article>
        <article className="summary-card">
          <span>Selected Boss</span>
          <strong>{boss?.definition.name ?? '—'}</strong>
          <small>{boss ? 'Boss-capable, scoped bridge' : 'No Boss selected'}</small>
        </article>
        <article className="summary-card">
          <span>Tasks</span>
          <strong>{snapshot?.tasks.length ?? 0}</strong>
          <small>
            {snapshot?.tasks.filter((task) => task.state === 'completed').length ?? 0} completed
          </small>
        </article>
        <article className="summary-card">
          <span>Runner</span>
          <strong>{snapshot?.runners[0]?.status ?? 'unknown'}</strong>
          <small>{snapshot?.runners[0]?.kind ?? 'No runner'}</small>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel span-2 setup-panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Local setup</p>
              <h2>Register ACP agent</h2>
            </div>
          </div>
          <form className="agent-form" onSubmit={(event) => void registerAgent(event)}>
            <label>
              Agent id
              <input
                required
                value={agentForm.id}
                onChange={(event) => setAgentForm({ ...agentForm, id: event.target.value })}
                placeholder="codex-local"
              />
            </label>
            <label>
              Display name
              <input
                required
                value={agentForm.name}
                onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })}
                placeholder="Local coding agent"
              />
            </label>
            <label className="span-form-2">
              Command
              <input
                required
                value={agentForm.command}
                onChange={(event) => setAgentForm({ ...agentForm, command: event.target.value })}
                placeholder="/absolute/or/PATH/agent-command"
              />
            </label>
            <label>
              Working directory
              <input
                value={agentForm.cwd}
                onChange={(event) => setAgentForm({ ...agentForm, cwd: event.target.value })}
                placeholder="optional"
              />
            </label>
            <label>
              Capabilities
              <input
                value={agentForm.capabilities}
                onChange={(event) =>
                  setAgentForm({ ...agentForm, capabilities: event.target.value })
                }
                placeholder="code.read, code.write"
              />
            </label>
            <label>
              Environment keys to inherit
              <input
                value={agentForm.environmentAllowlist}
                onChange={(event) =>
                  setAgentForm({ ...agentForm, environmentAllowlist: event.target.value })
                }
                placeholder="HOME, CUSTOM_AGENT_CONFIG"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={agentForm.canBeBoss}
                onChange={(event) =>
                  setAgentForm({ ...agentForm, canBeBoss: event.target.checked })
                }
              />
              Boss-capable with scoped Fleet MCP
            </label>
            <label className="span-form-2">
              Arguments, one per line
              <textarea
                rows={3}
                value={agentForm.args}
                onChange={(event) => setAgentForm({ ...agentForm, args: event.target.value })}
                placeholder="--acp\n--stdio"
              />
            </label>
            <div className="form-actions span-form-2">
              <button type="submit" disabled={busy !== null}>
                {busy === 'register' ? 'Registering…' : 'Register agent'}
              </button>
              <small>
                Environment values are never entered here; only explicitly allowed variable names
                are inherited by LocalRunner.
              </small>
            </div>
          </form>
        </section>

        <section className="panel span-2">
          <div className="panel-heading">
            <div>
              <p className="kicker">Registry</p>
              <h2>Agents</h2>
            </div>
            <Badge>{String(snapshot?.agents.length ?? 0)}</Badge>
          </div>
          <div className="agent-grid">
            {snapshot?.agents.map((agent) => (
              <article className="agent-card" key={agent.definition.id}>
                <div className="agent-title">
                  <div>
                    <strong>{agent.definition.name}</strong>
                    <small>{agent.definition.id}</small>
                  </div>
                  <Badge>
                    {agent.definition.orchestration.canBeBoss ? 'Boss eligible' : 'Worker'}
                  </Badge>
                </div>
                <div className="agent-meta">
                  <span>Runtime: {agent.readiness.runtime}</span>
                  <span>Auth: {agent.readiness.auth}</span>
                </div>
                {agent.error ? <p className="inline-error">{agent.error}</p> : null}
                <div className="chips">
                  {agent.definition.capabilities.map((capability) => (
                    <span key={capability.name}>{capability.name}</span>
                  ))}
                </div>
                <div className="card-actions">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void probe(agent.definition.id)}
                  >
                    {busy === `probe:${agent.definition.id}` ? 'Probing…' : 'Probe ACP'}
                  </button>
                  {agent.authMethods
                    .filter((method) => method.type !== 'terminal')
                    .map((method) => (
                      <button
                        type="button"
                        key={method.id}
                        disabled={busy !== null}
                        onClick={() => void authenticate(agent.definition.id, method.id)}
                      >
                        {busy === `auth:${agent.definition.id}`
                          ? 'Authorizing…'
                          : `Auth: ${method.name}`}
                      </button>
                    ))}
                </div>
                {agent.authMethods.some((method) => method.type === 'terminal') ? (
                  <small className="terminal-note">
                    Terminal authentication is advertised and must be completed interactively
                    outside this API.
                  </small>
                ) : null}
              </article>
            ))}
            {snapshot && snapshot.agents.length === 0 ? <Empty>No registered agents.</Empty> : null}
          </div>
        </section>

        <section className="panel span-2">
          <div className="panel-heading">
            <div>
              <p className="kicker">Orchestration</p>
              <h2>Boss selection</h2>
            </div>
          </div>
          <div className="boss-controls">
            <select
              aria-label="Select Boss agent"
              value={project?.defaultBossAgentId ?? ''}
              disabled={!project || busy !== null}
              onChange={(event) => void selectBoss(event.target.value)}
            >
              <option value="" disabled>
                Select an eligible Boss
              </option>
              {bossCandidates.map((agent) => (
                <option key={agent.definition.id} value={agent.definition.id}>
                  {agent.definition.name} ({agent.definition.id})
                </option>
              ))}
            </select>
            <small>
              Eligibility requires an enabled Boss-capable agent with MCP transport and the
              boss.orchestration scope.
            </small>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Durable graph</p>
              <h2>Tasks</h2>
            </div>
          </div>
          <div className="stack">
            {snapshot?.tasks.map((task) => (
              <article className="row-card" key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <small>{task.ownerAgentId ?? 'unassigned'}</small>
                </div>
                <Badge>{task.state}</Badge>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Observed history</p>
              <h2>Execution timeline</h2>
            </div>
          </div>
          <ol className="timeline">
            {snapshot?.timeline.map((event) => (
              <li key={event.id}>
                <span />
                <div>
                  <strong>{event.type}</strong>
                  <small>
                    {event.actor.id} · {new Date(event.occurredAt).toLocaleTimeString()}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel span-2">
          <div className="panel-heading">
            <div>
              <p className="kicker">Routed envelopes</p>
              <h2>Messages</h2>
            </div>
          </div>
          <div className="message-list">
            {snapshot?.messages.map((message) => (
              <article className="message-card" key={message.id}>
                <div className="message-route">
                  <strong>{message.fromAgentId}</strong>
                  <span>→</span>
                  <strong>{message.toAgentId ?? 'control-plane'}</strong>
                  <Badge>{message.type}</Badge>
                </div>
                <p>{message.content ?? 'No inline content'}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Policy</p>
              <h2>Approvals</h2>
            </div>
          </div>
          <div className="stack">
            {snapshot?.approvals.map((approval) => (
              <article className="row-card" key={approval.id}>
                <div>
                  <strong>{approval.action}</strong>
                  <small>{approval.enforcementMode}</small>
                </div>
                <Badge>{approval.state}</Badge>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Immutable output</p>
              <h2>Artifacts</h2>
            </div>
          </div>
          <div className="stack">
            {snapshot?.artifacts.map((artifact) => (
              <article className="row-card" key={artifact.id}>
                <div>
                  <strong>{artifact.id}</strong>
                  <small>
                    {artifact.producerAgentId ?? 'system'} · {artifact.sizeBytes} bytes
                  </small>
                </div>
                <Badge>{artifact.kind}</Badge>
              </article>
            ))}
          </div>
        </section>

        <section className="panel span-2">
          <div className="panel-heading">
            <div>
              <p className="kicker">Execution boundary</p>
              <h2>Runner & workspace</h2>
            </div>
          </div>
          <div className="boundary-grid">
            {snapshot?.runners.map((runner) => (
              <article className="boundary-card" key={runner.id}>
                <strong>{runner.id}</strong>
                <span>{runner.kind}</span>
                <Badge>{runner.status}</Badge>
              </article>
            ))}
            {snapshot?.workspaces.map((workspace) => (
              <article className="boundary-card" key={workspace.id}>
                <strong>{workspace.id}</strong>
                <span>{workspace.provider}</span>
                <Badge>{workspace.access}</Badge>
              </article>
            ))}
          </div>
          <p className="security-note">
            LocalRunner and Git worktrees are coordination boundaries, not OS security sandboxes.
          </p>
        </section>
      </div>
    </main>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
