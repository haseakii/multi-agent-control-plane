CREATE INDEX events_project_task_time_idx
ON events (project_id, json_extract(payload, '$.taskId'), occurred_at);
