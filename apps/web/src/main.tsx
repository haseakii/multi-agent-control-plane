import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type AuthMethod = { id: string; name: string; type?: string };
type Project = { id: string; name: string; defaultBossAgentId?: string };
type Task = {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  state: string;
  ownerAgentId?: string;
  resultArtifactRefs: string[];
};
type Artifact = {
  id: string;
  projectId: string;
  kind: string;
  producerAgentId?: string;
  sizeBytes: number;
  mimeType: string;
};

type Snapshot = {
  generatedAt: string;
  projects: Project[];
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
  tasks: Task[];
  timeline: Array<{
    id: string;
    projectId: string;
    type: string;
    occurredAt: string;
    actor: { id: string };
  }>;
  messages: Array<{
    id: string;
    projectId: string;
    fromAgentId: string;
    toAgentId?: string;
    type: string;
    content?: string;
    createdAt: string;
  }>;
  approvals: Array<{
    id: string;
    projectId: string;
    taskId?: string;
    requesterAgentId: string;
    action: string;
    resource: Record<string, unknown>;
    state: string;
    enforcementMode: string;
  }>;
  artifacts: Artifact[];
  runners: Array<{ id: string; kind: string; status: string }>;
  workspaces: Array<{ id: string; projectId: string; provider: string; access: string }>;
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

function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
  const canPreview =
    artifact.sizeBytes <= 65_536 &&
    (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json');

  useEffect(() => {
    if (!canPreview) {
      return;
    }
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Could not load result (HTTP ${response.status}).`);
        }
        const value = await response.text();
        if (!controller.signal.aborted) {
          setContent(value);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [canPreview, url]);

  return (
    <section className="panel span-2" aria-label="Result preview">
      <div className="panel-heading">
        <div>
          <p className="kicker">Durable result</p>
          <h2>{artifact.id}</h2>
        </div>
        <button type="button" onClick={onClose}>
          Close result
        </button>
      </div>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {canPreview && !error ? (
        content === null ? (
          <p>Loading result…</p>
        ) : (
          <pre className="result-content">{content}</pre>
        )
      ) : null}
      {!canPreview ? <p>Large or non-text outputs are available as artifacts.</p> : null}
      <a href={url} download>
        Download result
      </a>
    </section>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...(init ?? {}),
    headers,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentForm>(emptyAgentForm);
  const [projectName, setProjectName] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalObjective, setGoalObjective] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const snapshotRequest = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const request = ++snapshotRequest.current;
    try {
      const value = await api<Snapshot>('/api/control-center');
      if (request === snapshotRequest.current) {
        setSnapshot(value);
        setLoadError(null);
      }
    } catch (reason) {
      if (request === snapshotRequest.current) {
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    const refresh = async () => {
      await loadSnapshot();
      if (active) {
        timeout = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      ++snapshotRequest.current;
      window.clearTimeout(timeout);
    };
  }, [loadSnapshot]);

  const project =
    snapshot?.projects.find((item) => item.id === selectedProjectId) ?? snapshot?.projects[0];
  const tasks = snapshot?.tasks.filter((task) => task.projectId === project?.id) ?? [];
  const artifacts =
    snapshot?.artifacts.filter((artifact) => artifact.projectId === project?.id) ?? [];
  const approvals =
    snapshot?.approvals.filter((approval) => approval.projectId === project?.id) ?? [];
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
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
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await action();
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) {
      return;
    }
    await runAction('project', async () => {
      const created = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: projectName.trim() }),
      });
      setSelectedProjectId(created.id);
      setSelectedArtifactId(null);
      setProjectName('');
      setNotice(`Created ${created.name}. Select a Boss to begin.`);
    });
  };

  const submitGoal = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !boss || !goalObjective.trim()) {
      return;
    }
    await runAction('goal', async () => {
      const { task } = await api<{ task: Task }>(
        `/api/projects/${encodeURIComponent(project.id)}/goals`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(goalTitle.trim() ? { title: goalTitle.trim() } : {}),
            objective: goalObjective.trim(),
          }),
        },
      );
      setGoalTitle('');
      setGoalObjective('');
      setNotice(`Goal submitted: ${task.title}. Status updates automatically.`);
    });
  };

  const decideApproval = (approvalId: string, decision: 'approve' | 'reject') =>
    runAction(`approval:${approvalId}`, async () => {
      await api(`/api/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(decision === 'approve' ? 'Approval granted.' : 'Approval rejected.');
    });

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
          {loadError
            ? 'Control plane needs attention'
            : snapshot
              ? 'Control plane online'
              : 'Connecting…'}
        </div>
      </header>

      {loadError ? (
        <div className="error-card" role="alert">
          {loadError}
        </div>
      ) : null}
      {error ? (
        <div className="error-card" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="notice-card" role="status" aria-label="Action result">
          {notice}
        </div>
      ) : null}

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
          <strong>{tasks.length}</strong>
          <small>{tasks.filter((task) => task.state === 'completed').length} completed</small>
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
              <p className="kicker">Workspace setup</p>
              <h2>Projects</h2>
            </div>
          </div>
          <div className="project-controls">
            <label>
              Active project
              <select
                value={project?.id ?? ''}
                disabled={!snapshot?.projects.length || busy !== null}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setSelectedArtifactId(null);
                  setNotice(null);
                  setError(null);
                }}
              >
                <option value="" disabled>
                  No projects yet
                </option>
                {snapshot?.projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <form className="project-form" onSubmit={(event) => void createProject(event)}>
              <label>
                Project name
                <input
                  required
                  maxLength={256}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="My local project"
                  disabled={busy === 'project'}
                />
              </label>
              <button type="submit" disabled={busy !== null || !projectName.trim()}>
                {busy === 'project' ? 'Creating…' : 'Create project'}
              </button>
            </form>
          </div>
          {!project ? (
            <Empty>Create a project, register an ACP agent, then select its Boss.</Empty>
          ) : null}
        </section>

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
          <form className="goal-form" onSubmit={(event) => void submitGoal(event)}>
            <h3>Submit a goal</h3>
            <label>
              Goal title (optional)
              <input
                value={goalTitle}
                maxLength={256}
                onChange={(event) => setGoalTitle(event.target.value)}
                placeholder="Review the project"
                disabled={busy === 'goal'}
              />
            </label>
            <label>
              Goal objective
              <textarea
                required
                rows={4}
                maxLength={100_000}
                value={goalObjective}
                onChange={(event) => setGoalObjective(event.target.value)}
                placeholder="Describe the outcome you want the Boss to deliver."
                disabled={busy === 'goal'}
              />
            </label>
            <div className="form-actions">
              <button
                type="submit"
                disabled={
                  busy !== null ||
                  !project ||
                  !bossCandidates.some(
                    (agent) => agent.definition.id === project.defaultBossAgentId,
                  ) ||
                  !goalObjective.trim()
                }
              >
                {busy === 'goal' ? 'Submitting…' : 'Submit goal'}
              </button>
              <small>
                {!project
                  ? 'Create a project first.'
                  : !boss
                    ? 'Select an eligible Boss first.'
                    : `Runs with ${boss.definition.name}. Tasks and approvals update every 2 seconds.`}
              </small>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Durable graph</p>
              <h2>Tasks</h2>
            </div>
          </div>
          <div className="stack">
            {tasks.map((task) => (
              <article className="task-card" key={task.id}>
                <div className="task-heading">
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.ownerAgentId ?? 'unassigned'} · {task.id}
                    </small>
                  </div>
                  <Badge>{task.state}</Badge>
                </div>
                <p>{task.objective}</p>
                {task.resultArtifactRefs.length > 0 ? (
                  <div className="card-actions">
                    {task.resultArtifactRefs.map((id, index) => (
                      <button
                        type="button"
                        key={id}
                        disabled={!artifacts.some((artifact) => artifact.id === id)}
                        onClick={() => setSelectedArtifactId(id)}
                      >
                        {task.resultArtifactRefs.length === 1
                          ? 'View result'
                          : `View result ${index + 1}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {snapshot && tasks.length === 0 ? <Empty>No tasks in this project yet.</Empty> : null}
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
            {snapshot?.timeline
              .filter((event) => event.projectId === project?.id)
              .map((event) => (
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

        {selectedArtifact ? (
          <ArtifactPreview
            key={selectedArtifact.id}
            artifact={selectedArtifact}
            onClose={() => setSelectedArtifactId(null)}
          />
        ) : null}

        <section className="panel span-2">
          <div className="panel-heading">
            <div>
              <p className="kicker">Routed envelopes</p>
              <h2>Messages</h2>
            </div>
          </div>
          <div className="message-list">
            {snapshot?.messages
              .filter((message) => message.projectId === project?.id)
              .map((message) => (
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
            {approvals.map((approval) => (
              <article className="approval-card" key={approval.id}>
                <div className="task-heading">
                  <div>
                    <strong>{approval.action}</strong>
                    <small>
                      {approval.requesterAgentId} · {approval.enforcementMode}
                    </small>
                  </div>
                  <Badge>{approval.state}</Badge>
                </div>
                {approval.taskId ? <small>Task: {approval.taskId}</small> : null}
                <pre className="approval-resource">
                  {JSON.stringify(approval.resource, null, 2)}
                </pre>
                {approval.state === 'pending' ? (
                  <>
                    <p className="approval-note">
                      Review the requested action and resource. Nothing is approved automatically.
                    </p>
                    <div className="card-actions">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decideApproval(approval.id, 'approve')}
                      >
                        Approve
                      </button>
                      <button
                        className="reject-button"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decideApproval(approval.id, 'reject')}
                      >
                        Reject
                      </button>
                      {busy === `approval:${approval.id}` ? <small>Saving decision…</small> : null}
                    </div>
                  </>
                ) : null}
              </article>
            ))}
            {snapshot && approvals.length === 0 ? (
              <Empty>No approvals in this project.</Empty>
            ) : null}
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
            {artifacts.map((artifact) => (
              <article className="row-card" key={artifact.id}>
                <div>
                  <strong>{artifact.id}</strong>
                  <small>
                    {artifact.producerAgentId ?? 'system'} · {artifact.sizeBytes} bytes
                  </small>
                </div>
                <div className="artifact-actions">
                  <Badge>{artifact.kind}</Badge>
                  <button type="button" onClick={() => setSelectedArtifactId(artifact.id)}>
                    View artifact
                  </button>
                </div>
              </article>
            ))}
            {snapshot && artifacts.length === 0 ? (
              <Empty>No artifacts in this project yet.</Empty>
            ) : null}
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
            {snapshot?.workspaces
              .filter((workspace) => workspace.projectId === project?.id)
              .map((workspace) => (
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
