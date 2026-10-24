CREATE TABLE project_workspace_configs (
  id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE assignment_workspaces (
  id TEXT PRIMARY KEY NOT NULL REFERENCES assignments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX assignment_workspaces_task_idx ON assignment_workspaces(task_id);
--> statement-breakpoint
INSERT INTO project_workspace_configs(id, source_workspace_id, payload)
SELECT p.id, w.id, json_object('id', p.id, 'sourceWorkspaceId', w.id, 'mode', 'unconfigured',
  'updatedAt', json_extract(p.payload, '$.updatedAt'))
FROM projects p JOIN workspaces w ON w.project_id = p.id
WHERE (SELECT count(*) FROM workspaces x WHERE x.project_id = p.id) = 1;
--> statement-breakpoint
INSERT INTO assignment_workspaces(id, project_id, task_id, workspace_id, source_workspace_id, payload)
SELECT a.id, t.project_id, a.task_id, c.source_workspace_id, c.source_workspace_id,
  json_object('id', a.id, 'projectId', t.project_id, 'taskId', a.task_id,
    'workspaceId', c.source_workspace_id, 'sourceWorkspaceId', c.source_workspace_id,
    'mode', 'shared-directory', 'createdAt', json_extract(a.payload, '$.createdAt'))
FROM assignments a JOIN tasks t ON t.id = a.task_id
JOIN project_workspace_configs c ON c.id = t.project_id;
