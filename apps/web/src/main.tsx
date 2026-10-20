import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Snapshot = {
  generatedAt: string;
  projects: Array<{ id: string; name: string; defaultBossAgentId?: string }>;
  agents: Array<{
    definition: {
      id: string;
      name: string;
      enabled: boolean;
      orchestration: { canBeBoss: boolean };
      capabilities: Array<{ name: string }>;
    };
    readiness: { runtime: string; auth: string };
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

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}

function Empty({ children }: { children: string }) {
  return <p className="empty">{children}</p>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/control-center')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Control-center API returned ${response.status}`);
        }
        return (await response.json()) as Snapshot;
      })
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

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL-FIRST · V0 CONTROL CENTER</p>
          <h1>Multi-Agent Control Plane</h1>
          <p className="intro">
            Observe agents, durable tasks, messages, approvals, artifacts, and execution history
            without assigning fixed vendor roles.
          </p>
        </div>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          {error ? 'Control plane unavailable' : snapshot ? 'Control plane online' : 'Connecting…'}
        </div>
      </header>

      {error ? <div className="error-card">{error}</div> : null}

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
                <div className="chips">
                  {agent.definition.capabilities.map((capability) => (
                    <span key={capability.name}>{capability.name}</span>
                  ))}
                </div>
              </article>
            ))}
            {snapshot && snapshot.agents.length === 0 ? <Empty>No registered agents.</Empty> : null}
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
