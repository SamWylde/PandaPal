import { addonBuilder } from 'stremio-addon-sdk';
import { Type } from './lib/types.js';
import { dummyManifest } from './lib/manifest.js';
import { cacheWrapStream } from './lib/cache.js';
import { toStreamInfo, applyStaticInfo } from './lib/streamInfo.js';
import * as repository from './lib/repository.js';
import { searchTorrents, deduplicateTorrents } from './lib/realtime.js';
import applySorting from './lib/sort.js';
import applyFilters from './lib/filter.js';
import { applyMochs, getMochCatalog, getMochItemMeta } from './moch/moch.js';
import StaticLinks from './moch/static.js';
import { createNamedQueue } from "./lib/namedQueue.js";
import pLimit from "p-limit";

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 60 * 60; // 1 hour in seconds
const CACHE_MAX_AGE_EMPTY = 60; // 60 seconds
const CATALOG_CACHE_MAX_AGE = 0; // 0 minutes
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const builder = new addonBuilder(dummyManifest());
const requestQueue = createNamedQueue(Infinity);
const newLimiter = pLimit(30)

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && !args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  return requestQueue.wrap(args.id, () => resolveStreams(args))
    .then(streams => applyFilters(streams, args.extra))
    .then(streams => applySorting(streams, args.extra, args.type))
    .then(streams => applyStaticInfo(streams))
    .then(streams => applyMochs(streams, args.extra))
    .then(streams => enrichCacheParams(streams))
    .catch(error => {
      console.error(`Failed request ${args.id}:`, error);
      return { streams: [], cacheMaxAge: CACHE_MAX_AGE_EMPTY };
    });
});

builder.defineCatalogHandler((args) => {
  const [_, mochKey, catalogId] = args.id.split('-');
  console.log(`Incoming catalog ${args.id} request with skip=${args.extra.skip || 0}`)
  return getMochCatalog(mochKey, catalogId, args.extra)
    .then(metas => ({
      metas: metas,
      cacheMaxAge: CATALOG_CACHE_MAX_AGE
    }))
    .catch(error => {
      return Promise.reject(`Failed retrieving catalog ${args.id}: ${JSON.stringify(error.message || error)}`);
    });
})

builder.defineMetaHandler((args) => {
  const [mochKey, metaId] = args.id.split(':');
  console.log(`Incoming debrid meta ${args.id} request`)
  return getMochItemMeta(mochKey, metaId, args.extra)
    .then(meta => ({
      meta: meta,
      cacheMaxAge: metaId === 'Downloads' ? 0 : CACHE_MAX_AGE
    }))
    .catch(error => {
      return Promise.reject(`Failed retrieving catalog meta ${args.id}: ${JSON.stringify(error)}`);
    });
})

async function resolveStreams(args) {
  return cacheWrapStream(args.id, () => newLimiter(() => streamHandler(args)));
}

async function streamHandler(args) {
  console.log(`[StreamHandler] Processing ${args.id} (${args.type})`);

  // Parse the ID
  const { imdbId, kitsuId, season, episode } = parseId(args.id);

  // 1. Check Supabase cache first
  const cachedResults = await repository.getCachedTorrents(imdbId, kitsuId, args.type, season, episode);

  if (cachedResults.length > 0) {
    console.log(`[StreamHandler] Cache hit: ${cachedResults.length} results`);
    return formatResults(cachedResults);
  }

  // 2. Real-time search
  console.log(`[StreamHandler] Cache miss, starting real-time search...`);
  const torrents = await searchTorrents({
    imdbId,
    kitsuId,
    type: args.type,
    season,
    episode,
    title: args.extra?.name, // Fallback title for anime
    providers: args.extra?.providers, // User-selected providers (or 'smart')
    config: args.extra // Full config for additional options
  });

  // 3. Deduplicate
  const uniqueTorrents = deduplicateTorrents(torrents);

  // 4. Save to Supabase (non-blocking)
  if (uniqueTorrents.length > 0) {
    repository.saveTorrents(uniqueTorrents).catch(err => {
      console.error('[StreamHandler] Background save error:', err);
    });
  }

  // 5. Return formatted results
  return formatRealtimeResults(uniqueTorrents);
}

function parseId(id) {
  // IMDB movie: tt1375666
  // IMDB series: tt0944947:1:1 (season:episode)
  // Kitsu: kitsu:12345 or kitsu:12345:1 (episode)

  let imdbId, kitsuId, season, episode;

  if (id.match(/^tt\d+$/)) {
    imdbId = id;
  } else if (id.match(/^tt\d+:\d+:\d+$/)) {
    const parts = id.split(':');
    imdbId = parts[0];
    season = parseInt(parts[1]);
    episode = parseInt(parts[2]);
  } else if (id.match(/^kitsu:\d+$/i)) {
    kitsuId = id.split(':')[1];
  } else if (id.match(/^kitsu:\d+:\d+$/i)) {
    const parts = id.split(':');
    kitsuId = parts[1];
    episode = parseInt(parts[2]);
  }

  return { imdbId, kitsuId, season, episode };
}

function formatResults(cachedResults) {
  // Format cached Supabase results to match expected structure
  return cachedResults.map(record => ({
    ...record,
    torrent: record.torrent || {
      infoHash: record.infoHash,
      seeders: record.seeders || 0,
      uploadDate: record.uploadDate
    }
  })).map(record => toStreamInfo(record));
}

function formatRealtimeResults(torrents) {
  // Format real-time results to streams
  return torrents.map(t => ({
    name: `[${t.provider}] ${t.resolution || ''}`,
    title: `${t.title}\n👤 ${t.seeders || 0} · 💾 ${formatSize(t.size)}`,
    infoHash: t.infoHash,
    behaviorHints: {
      bingeGroup: `torrentio|${t.infoHash}`
    }
  }));
}

function formatSize(bytes) {
  if (!bytes) return 'N/A';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function enrichCacheParams(streams) {
  let cacheAge = CACHE_MAX_AGE;
  if (!streams.length) {
    cacheAge = CACHE_MAX_AGE_EMPTY;
  } else if (streams.every(stream => stream?.url?.endsWith(StaticLinks.FAILED_ACCESS))) {
    cacheAge = 0;
  }
  return {
    streams: streams,
    cacheMaxAge: cacheAge,
    staleRevalidate: STALE_REVALIDATE_AGE,
    staleError: STALE_ERROR_AGE
  }
}

export default builder.getInterface();
