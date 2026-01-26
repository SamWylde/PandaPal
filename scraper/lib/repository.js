import { supabase } from './db.js';

if (!supabase) {
  console.log('Repository: SUPABASE_URL or SUPABASE_KEY is NOT set. Scraper will run without database persistence.');
} else {
  console.log('Repository: Supabase client initialized.');
}

// Simple in-memory lock to prevent concurrent saves for same content
// Key: contentId (imdbId or kitsuId), Value: Promise
const saveLocks = new Map();

/**
 * Acquire a lock for a content ID
 * Returns a release function to call when done
 */
async function acquireSaveLock(contentId) {
  // Wait for any existing lock to be released
  while (saveLocks.has(contentId)) {
    await saveLocks.get(contentId);
  }

  // Create new lock
  let releaseLock;
  const lockPromise = new Promise(resolve => {
    releaseLock = resolve;
  });
  saveLocks.set(contentId, lockPromise);

  return () => {
    saveLocks.delete(contentId);
    releaseLock();
  };
}

export async function getTorrent(infoHash) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('torrent')
    .select('*')
    .eq('infoHash', infoHash)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows found"
    console.error('Error fetching torrent:', error);
  }
  return data;
}

export async function getFiles(infoHashes) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file')
    .select('*')
    .in('infoHash', infoHashes);

  if (error) {
    console.error('Error fetching files:', error);
    return [];
  }
  return data;
}

export async function getImdbIdMovieEntries(imdbId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file')
    .select('*, torrent!inner(*)')
    .eq('imdbId', imdbId)
    .order('seeders', { foreignTable: 'torrent', ascending: false })
    .limit(500);

  if (error) {
    console.error('Error fetching IMDB movie entries:', error);
    return [];
  }
  // Morph data to match Sequelize structure (where torrent is a property)
  return data;
}

export async function getImdbIdSeriesEntries(imdbId, season, episode) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file')
    .select('*, torrent!inner(*)')
    .eq('imdbId', imdbId)
    .eq('imdbSeason', season)
    .eq('imdbEpisode', episode)
    .order('seeders', { foreignTable: 'torrent', ascending: false })
    .limit(500);

  if (error) {
    console.error('Error fetching IMDB series entries:', error);
    return [];
  }
  return data;
}

export async function getKitsuIdMovieEntries(kitsuId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file')
    .select('*, torrent!inner(*)')
    .eq('kitsuId', kitsuId)
    .order('seeders', { foreignTable: 'torrent', ascending: false })
    .limit(500);

  if (error) {
    console.error('Error fetching Kitsu movie entries:', error);
    return [];
  }
  return data;
}

export async function getKitsuIdSeriesEntries(kitsuId, episode) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file')
    .select('*, torrent!inner(*)')
    .eq('kitsuId', kitsuId)
    .eq('kitsuEpisode', episode)
    .order('seeders', { foreignTable: 'torrent', ascending: false })
    .limit(500);

  if (error) {
    console.error('Error fetching Kitsu series entries:', error);
    return [];
  }
  return data;
}

// ===== SAVE FUNCTIONS FOR REAL-TIME SCRAPING =====

const CACHE_HOURS = 24;

/**
 * Save torrents to Supabase with lock to prevent race conditions
 * When multiple clients search for the same content simultaneously,
 * this ensures saves happen sequentially to avoid data loss.
 */
export async function saveTorrents(torrents) {
  if (!supabase || !torrents.length) return;

  // Get content ID for locking (use first torrent's ID)
  const contentId = torrents[0]?.imdbId || torrents[0]?.kitsuId || 'unknown';

  // Acquire lock for this content
  const releaseLock = await acquireSaveLock(contentId);

  try {
    const now = new Date().toISOString();

    // Prepare torrent records
    const torrentRecords = torrents.map(t => ({
      infoHash: t.infoHash,
      provider: t.provider,
      title: t.title,
      size: t.size,
      type: t.type,
      uploadDate: t.uploadDate?.toISOString() || now,
      seeders: t.seeders,
      resolution: t.resolution,
      fetched_at: now
    }));

    // Upsert torrents - always update seeders to get fresh count
    const { error: torrentError } = await supabase
      .from('torrent')
      .upsert(torrentRecords, {
        onConflict: 'infoHash',
        // Update these fields on conflict (merge, don't overwrite)
        ignoreDuplicates: false
      });

    if (torrentError) {
      console.error('Error saving torrents:', torrentError);
      return;
    }

    // Prepare file records
    const fileRecords = torrents.map(t => ({
      infoHash: t.infoHash,
      title: t.title,
      size: t.size,
      imdbId: t.imdbId,
      imdbSeason: t.imdbSeason,
      imdbEpisode: t.imdbEpisode,
      kitsuId: t.kitsuId,
      kitsuEpisode: t.kitsuEpisode,
      fetched_at: now
    }));

    // Upsert files - use onConflict to properly handle duplicates
    const { error: fileError } = await supabase
      .from('file')
      .upsert(fileRecords, {
        onConflict: 'infoHash,title',
        ignoreDuplicates: false // Update fetched_at on re-save
      });

    if (fileError && !fileError.message?.includes('duplicate')) {
      console.error('Error saving files:', fileError);
    }

    console.log(`Repository: Saved ${torrents.length} torrents for ${contentId}`);
  } catch (error) {
    console.error('Repository: Error in saveTorrents:', error);
  } finally {
    // Always release lock
    releaseLock();
  }
}

/**
 * Get cached torrents if not older than CACHE_HOURS
 */
export async function getCachedTorrents(imdbId, kitsuId, type, season, episode) {
  if (!supabase) return [];

  try {
    const cacheThreshold = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('file')
      .select('*, torrent!inner(*)')
      .gte('fetched_at', cacheThreshold);

    if (imdbId) {
      query = query.eq('imdbId', imdbId);
    }
    if (kitsuId) {
      query = query.eq('kitsuId', kitsuId);
    }
    if (season !== undefined) {
      query = query.eq('imdbSeason', season);
    }
    if (episode !== undefined) {
      query = query.eq('imdbEpisode', episode);
    }

    const { data, error } = await query.limit(500);

    if (error) {
      console.error('Error getting cached torrents:', error);
      return [];
    }

    console.log(`Repository: Cache hit - ${data?.length || 0} torrents for ${imdbId || kitsuId}`);
    return data || [];
  } catch (error) {
    console.error('Repository: Error in getCachedTorrents:', error);
    return [];
  }
}
