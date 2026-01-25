-- CloudFlare Sessions Table
-- Stores solved CF challenge cookies for reuse

CREATE TABLE IF NOT EXISTS cf_sessions (
    domain TEXT PRIMARY KEY,
    cookies JSONB NOT NULL,
    user_agent TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    solve_count INTEGER DEFAULT 1,
    last_success TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for cleanup of expired sessions
CREATE INDEX IF NOT EXISTS idx_cf_sessions_expires_at ON cf_sessions(expires_at);

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_cf_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    NEW.solve_count = OLD.solve_count + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS cf_sessions_updated_at ON cf_sessions;
CREATE TRIGGER cf_sessions_updated_at
    BEFORE UPDATE ON cf_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_cf_sessions_updated_at();

-- Comment for documentation
COMMENT ON TABLE cf_sessions IS 'Stores Cloudflare bypass cookies for indexer domains';
COMMENT ON COLUMN cf_sessions.domain IS 'The domain (e.g., 1337x.to) this session is valid for';
COMMENT ON COLUMN cf_sessions.cookies IS 'JSON array of cookies from successful CF bypass';
COMMENT ON COLUMN cf_sessions.user_agent IS 'User-Agent string used during the solve';
COMMENT ON COLUMN cf_sessions.expires_at IS 'When these cookies expire (usually 30min-24h)';
COMMENT ON COLUMN cf_sessions.solve_count IS 'Number of times we have solved CF for this domain';
