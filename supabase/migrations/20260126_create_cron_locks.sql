-- Simple cron locking table to prevent concurrent job execution
-- Used by health check and other cron jobs to ensure only one instance runs at a time

CREATE TABLE IF NOT EXISTS cron_locks (
    id TEXT PRIMARY KEY,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add index for efficient expiry checking
CREATE INDEX IF NOT EXISTS idx_cron_locks_locked_at ON cron_locks(locked_at);

-- Add columns to indexer_health for circuit breaker
ALTER TABLE indexer_health
ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS disabled_until TIMESTAMPTZ;

-- Add index for efficient disabled check
CREATE INDEX IF NOT EXISTS idx_indexer_health_disabled_until ON indexer_health(disabled_until);

COMMENT ON TABLE cron_locks IS 'Distributed locking for cron jobs to prevent concurrent execution';
COMMENT ON COLUMN indexer_health.consecutive_failures IS 'Number of consecutive health check failures';
COMMENT ON COLUMN indexer_health.disabled_until IS 'Circuit breaker: indexer disabled until this time';
