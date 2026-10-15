CREATE INDEX IF NOT EXISTS idx_albums_created ON albums(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_work_status_type_error_heartbeat
  ON work_queue(status, task_type, error_message, heartbeat_at);

INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('media_container_budget_hours', '0', 'Media container runtime budget per billing cycle (hours, 0 disables)'),
  ('media_container_billing_day', '1', 'Media container billing cycle start day (UTC, 1–28)');
