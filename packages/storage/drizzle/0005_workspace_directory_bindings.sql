CREATE TABLE workspace_directory_bindings (
 id text PRIMARY KEY NOT NULL REFERENCES workspaces(id),
 project_id text NOT NULL REFERENCES projects(id),
 path_key text NOT NULL, device_id text NOT NULL, file_id text NOT NULL, payload text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_binding_path_idx ON workspace_directory_bindings(path_key);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_binding_identity_idx ON workspace_directory_bindings(device_id,file_id);
