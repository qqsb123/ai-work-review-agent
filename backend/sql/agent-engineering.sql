-- Additive tables only. Original users/reports remain unchanged.
CREATE TABLE IF NOT EXISTS report_embeddings (
  user_id BIGINT UNSIGNED NOT NULL,
  report_id BIGINT UNSIGNED NOT NULL,
  model_key VARCHAR(64) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  vector JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, report_id, model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id CHAR(36) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  request_key VARCHAR(80) NOT NULL,
  task VARCHAR(32) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  input_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt INT NOT NULL DEFAULT 0,
  lease_token CHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  checkpoint_json JSON NULL,
  result_json JSON NULL,
  error_code VARCHAR(80) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX idx_run_request (user_id, request_key),
  INDEX idx_run_history (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_run_events (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  run_id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  attempt INT NOT NULL,
  event_json JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_run_events (user_id, run_id, id),
  CONSTRAINT fk_trace_run FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_drafts (
  session_id CHAR(36) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  draft_json JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_draft_owner (user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
