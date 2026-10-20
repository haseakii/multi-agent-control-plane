ALTER TABLE workspaces ADD COLUMN branch_name text;
--> statement-breakpoint
UPDATE workspaces
SET branch_name = json_extract(payload, '$.branchName')
WHERE json_extract(payload, '$.branchName') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX workspaces_project_branch_idx
ON workspaces (project_id, branch_name);
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN assignment_id text;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN action text;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN enforcement_mode text;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN boundary text;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN requested_at text;
--> statement-breakpoint
UPDATE approvals
SET assignment_id = json_extract(payload, '$.assignmentId'),
    action = json_extract(payload, '$.action'),
    enforcement_mode = json_extract(payload, '$.enforcementMode'),
    boundary = json_extract(payload, '$.boundary'),
    requested_at = json_extract(payload, '$.requestedAt');
--> statement-breakpoint
CREATE INDEX approvals_project_pending_time_idx
ON approvals (project_id, state, requested_at);
