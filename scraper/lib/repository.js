import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Repository: SUPABASE_URL or SUPABASE_KEY is NOT set. Scraper will run without database persistence.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

if (supabase) {
  console.log('Repository: Supabase client initialized.');
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
