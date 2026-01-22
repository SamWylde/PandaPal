-- Create tables for Cyberflix Catalogs

-- 1. manifest table
CREATE TABLE IF NOT EXISTS public.manifest (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);

-- 2. catalogs table
CREATE TABLE IF NOT EXISTS public.catalogs (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);

-- 3. tmdb_ids table
CREATE TABLE IF NOT EXISTS public.tmdb_ids (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);

-- 4. metas table
CREATE TABLE IF NOT EXISTS public.metas (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);

-- 5. changes table (for history/tracking)
CREATE TABLE IF NOT EXISTS public.changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name text NOT NULL,
    deleted_keys jsonb DEFAULT '[]'::jsonb,
    updated_keys jsonb DEFAULT '[]'::jsonb,
    inserted_keys jsonb DEFAULT '[]'::jsonb,
    timestamp timestamptz DEFAULT now()
);

-- RPC Function: manifest
-- Used as a health check and to fetch manifest data
CREATE OR REPLACE FUNCTION public.manifest()
RETURNS SETOF manifest AS $$
BEGIN
    RETURN QUERY SELECT * FROM manifest;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable RLS (Optional, but recommended. For simplicity, we can start with full access if the project is private)
ALTER TABLE public.manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tmdb_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.changes ENABLE ROW LEVEL SECURITY;

-- Create basic policies for access (adjust as needed)
CREATE POLICY "Allow service_role full access" ON public.manifest FOR ALL USING (true);
CREATE POLICY "Allow service_role full access" ON public.catalogs FOR ALL USING (true);
CREATE POLICY "Allow service_role full access" ON public.tmdb_ids FOR ALL USING (true);
CREATE POLICY "Allow service_role full access" ON public.metas FOR ALL USING (true);
CREATE POLICY "Allow service_role full access" ON public.changes FOR ALL USING (true);

-- 6. torrentio_addon_cache table (for KeyvPostgres)
CREATE TABLE IF NOT EXISTS public.torrentio_addon_cache (
  "key" VARCHAR(255) PRIMARY KEY,
  "value" TEXT NOT NULL,
  "expires" BIGINT
);

-- Enable RLS and create policy (optional)
ALTER TABLE public.torrentio_addon_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service_role full access" ON public.torrentio_addon_cache FOR ALL USING (true);

-- 7. torrent table (for real-time scraper)
CREATE TABLE IF NOT EXISTS public.torrent (
  "infoHash" VARCHAR(40) PRIMARY KEY,
  "provider" VARCHAR(50),
  "title" TEXT,
  "size" BIGINT,
  "type" VARCHAR(20),
  "uploadDate" TIMESTAMPTZ,
  "seeders" INTEGER,
  "resolution" VARCHAR(10),
  "fetched_at" TIMESTAMPTZ DEFAULT now()
);

-- 8. file table (for real-time scraper)
CREATE TABLE IF NOT EXISTS public.file (
  "infoHash" VARCHAR(40),
  "title" TEXT,
  "size" BIGINT,
  "imdbId" VARCHAR(20),
  "imdbSeason" INTEGER,
  "imdbEpisode" INTEGER,
  "kitsuId" VARCHAR(20),
  "kitsuEpisode" INTEGER,
  "fetched_at" TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY ("infoHash", "title")
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_file_imdbId ON public.file("imdbId");
CREATE INDEX IF NOT EXISTS idx_file_kitsuId ON public.file("kitsuId");
CREATE INDEX IF NOT EXISTS idx_file_fetched_at ON public.file("fetched_at");
CREATE INDEX IF NOT EXISTS idx_torrent_fetched_at ON public.torrent("fetched_at");

-- Enable RLS and create policies
ALTER TABLE public.torrent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service_role full access" ON public.torrent FOR ALL USING (true);
CREATE POLICY "Allow service_role full access" ON public.file FOR ALL USING (true);
