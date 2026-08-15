-- The browser work pool no longer polls, so its two cadence tunables have no
-- reader. Removing the rows keeps the settings UI from offering knobs that do
-- nothing. worker_pool_enabled, worker_claim_ttl_seconds and
-- worker_max_concurrent all still apply and are left alone.
DELETE FROM feature_strings
 WHERE key IN ('worker_poll_interval_seconds', 'worker_batch_size');

INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('sandbox_idle_timeout_seconds', '150', 'Sandbox container idle timeout in seconds (15|150|300)');
