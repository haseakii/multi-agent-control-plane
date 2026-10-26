CREATE TABLE project_policies (
  id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
  payload TEXT NOT NULL
);
