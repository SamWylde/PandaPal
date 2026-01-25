/**
 * Real-time Torrent Search
 *
 * Uses health-prioritized indexers from the database.
 * Falls back to legacy scrapers if health data unavailable.
 *
 * Indexers are sorted by priority (calculated from success rate + speed).
 *
 * Hospital-grade reliability: All operations have timeouts to prevent hangs.
 */

import { searchYTS } from './sources/yts.js';
import { searchEZTV } from './sources/eztv.js';
import { searchNyaa } from './sources/nyaa.js';
import { search1337x } from './sources/t1337x.js';
import { searchTorrentGalaxy } from './sources/torrentgalaxy.js';
import { searchBitSearch } from './sources/bitsearch.js';
import { searchSolidTorrents } from './sources/solidtorrents.js';
import { getWorkingIndexers } from './healthCheck.js';
import { searchWithCardigann } from './cardigann/search.js';
import { getCachedSession } from './cfSolver.js';

// Hospital-grade timeout: Ensures search never hangs
const MAX_SEARCH_TIMEOUT_MS = 45000; // 45 seconds max for entire search

const withTimeout = (promise, ms, fallback = []) => {
    const timeout = new Promise((resolve) =>
        setTimeout(() => {
            console.warn(`[RealTime] Operation timed out after ${ms}ms, returning fallback`);
            resolve(fallback);
        }, ms)
    );
    return Promise.race([promise, timeout]);
};

// Map Prowlarr indexer IDs to legacy scraper functions
// These are used when we have working domains from health checks
const LEGACY_SCRAPERS = {
    'yts': { search: searchYTS, types: ['movie'] },
    'eztv': { search: searchEZTV, types: ['series'] },
    'nyaasi': { search: searchNyaa, types: ['anime'] },
    '1337x': { search: search1337x, types: ['movie', 'series'] },
    'torrentgalaxyclone': { search: searchTorrentGalaxy, types: ['movie', 'series'] },
    'bitsearch': { search: searchBitSearch, types: ['movie', 'series', 'anime'] },
};

// Custom scrapers not in Prowlarr (always run as fallback)
const CUSTOM_SCRAPERS = {
    'solidtorrents': { search: searchSolidTorrents, types: ['movie', 'series', 'anime'] },
};

// STRICT content type mapping - indexers MUST only be used for their supported types
// This prevents anime/hentai/game indexers from being searched for movies
const INDEXER_CONTENT_TYPES = {
    // Movie indexers
    'yts': ['movie'],
    'yts-mx': ['movie'],

    // TV/Series indexers
    'eztv': ['series'],
    'showrss': ['series'],
    'showrss-yml': ['series'],

    // Anime indexers
    'nyaasi': ['anime'],
    'tokyotosho': ['anime'],
    'anidex': ['anime'],
    'anisource': ['anime'],
    'shanaproject': ['anime'],
    'dmhy': ['anime'],
    'acgrip': ['anime'],
    'bangumi': ['anime'],

    // Hentai/Adult - NEVER use for regular content
    'ehentai': [],
    'sukebei': [],
    'pornleech': [],

    // Games - NEVER use for movies/series
    'catorrent': [],
    'skidrowrepack': [],
    'fitgirl': [],

    // General purpose (movies + series)
    '1337x': ['movie', 'series'],
    'torrentgalaxyclone': ['movie', 'series'],
    'thepiratebay': ['movie', 'series', 'anime'],
    'limetorrents': ['movie', 'series'],
    'bitsearch': ['movie', 'series', 'anime'],
    'magnetdl': ['movie', 'series'],
    'kickasstorrents': ['movie', 'series'],
    'rarbg': ['movie', 'series'],
    'solidtorrents': ['movie', 'series', 'anime'],
    'btdig': ['movie', 'series', 'anime'],
    'internetarchive': ['movie', 'series'],
    'rutracker': ['movie', 'series', 'anime'],

    // French
    'cpasbienclone': ['movie', 'series'],
    'yggtorrent': ['movie', 'series'],
    'oxtorrent': ['movie', 'series'],

    // Spanish
    'mejortorrent': ['movie', 'series'],
    'divxtotal': ['movie', 'series'],

    // Russian
    'rutor': ['movie', 'series'],
    'kinozal': ['movie', 'series'],

    // Magnet aggregators
    'magnetcat': ['movie', 'series'],
    'damagnet': ['movie', 'series'],
    'megapeer': ['movie', 'series'],
};

// Fallback: indexers not in the list above are assumed general purpose
const DEFAULT_CONTENT_TYPES = ['movie', 'series'];

/**
 * Check if an indexer supports a given content type
 */
function indexerSupportsType(indexerId, contentType) {
    const supported = INDEXER_CONTENT_TYPES[indexerId];
    if (supported === undefined) {
        // Unknown indexer - assume general purpose but log warning
        console.warn(`[RealTime] Unknown indexer "${indexerId}" - assuming general purpose`);
        return DEFAULT_CONTENT_TYPES.includes(contentType);
    }
    return supported.includes(contentType);
}

/**
 * Real-time torrent search with health-prioritized indexers
 * Wrapped with hospital-grade timeout to prevent hangs
 */
export async function searchTorrents(params) {
    return withTimeout(
        searchTorrentsInternal(params),
        MAX_SEARCH_TIMEOUT_MS,
        [] // Return empty array on timeout
    );
}

/**
 * Internal search implementation
 */
async function searchTorrentsInternal(params) {
    const { imdbId, kitsuId, type, season, episode, title, providers, config } = params;
    const searchQuery = title || imdbId || kitsuId;

    console.log(`[RealTime] Starting search for ${searchQuery} (${type})`);

    // Check if user selected specific providers or wants smart mode
    const useSmartMode = !providers || providers.length === 0 || providers.includes('smart');
    const selectedProviders = providers?.filter(p => p !== 'smart') || [];

    if (useSmartMode) {
        console.log(`[RealTime] Using SMART mode (health-prioritized indexers)`);

        // Get health-prioritized indexers
        let prioritizedIndexers = [];
        try {
            prioritizedIndexers = await getWorkingIndexers({ limit: 30 });
            console.log(`[RealTime] Got ${prioritizedIndexers.length} prioritized indexers from health data`);
        } catch (err) {
            console.log(`[RealTime] Failed to get health data: ${err.message}, using fallback`);
        }

        // If we have health data, use prioritized search
        if (prioritizedIndexers.length > 0 && prioritizedIndexers[0].priority !== undefined) {
            return searchWithPriority(params, prioritizedIndexers);
        }

        // Fallback to legacy tiered approach
        console.log(`[RealTime] No health data, falling back to legacy search`);
        return searchLegacy(params);
    }

    // Manual provider selection - use only selected providers
    console.log(`[RealTime] Using MANUAL mode with providers: ${selectedProviders.join(', ')}`);
    return searchSelectedProviders(params, selectedProviders);
}

/**
 * Search only user-selected providers (manual mode)
 */
async function searchSelectedProviders(params, selectedProviders) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const promises = [];

    for (const providerId of selectedProviders) {
        // Check legacy scrapers first
        if (LEGACY_SCRAPERS[providerId]) {
            const scraper = LEGACY_SCRAPERS[providerId];
            if (scraper.types.includes(type)) {
                promises.push(
                    runLegacyScraper(providerId, scraper, params, null)
                        .catch(err => {
                            console.log(`[RealTime] ${providerId} failed: ${err.message}`);
                            return [];
                        })
                );
            }
        }
        // Check custom scrapers
        else if (CUSTOM_SCRAPERS[providerId]) {
            const scraper = CUSTOM_SCRAPERS[providerId];
            if (scraper.types.includes(type)) {
                promises.push(
                    scraper.search(imdbId || title, true)
                        .catch(err => {
                            console.log(`[RealTime] ${providerId} failed: ${err.message}`);
                            return [];
                        })
                );
            }
        }
        // Try Cardigann engine for other indexers
        else {
            promises.push(
                searchWithCardigann(providerId, title || imdbId, {
                    imdbId,
                    type,
                    season,
                    episode
                }).catch(err => {
                    console.log(`[RealTime] ${providerId} (Cardigann) failed: ${err.message}`);
                    return [];
                })
            );
        }
    }

    if (promises.length === 0) {
        console.log(`[RealTime] No valid providers for type ${type}`);
        return [];
    }

    const results = await Promise.allSettled(promises);
    const torrents = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value || []);

    console.log(`[RealTime] Manual mode returned ${torrents.length} results`);
    return torrents;
}

/**
 * Search using health-prioritized indexers
 * CRITICAL: Only uses indexers that support the requested content type
 */
async function searchWithPriority(params, indexers) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const allResults = [];

    // STRICT TYPE FILTERING: Only use indexers that support this content type
    // This prevents anime/hentai/game indexers from being searched for movies
    const compatibleIndexers = indexers.filter(idx => indexerSupportsType(idx.id, type));
    const incompatibleCount = indexers.length - compatibleIndexers.length;

    if (incompatibleCount > 0) {
        console.log(`[RealTime] Filtered out ${incompatibleCount} indexers incompatible with "${type}"`);
    }

    if (compatibleIndexers.length === 0) {
        console.log(`[RealTime] No compatible indexers for type "${type}", falling back to legacy`);
        return searchLegacy(params);
    }

    // Sort by priority (best first)
    const sortedIndexers = compatibleIndexers.sort((a, b) => b.priority - a.priority);

    console.log(`[RealTime] Searching ${sortedIndexers.length} compatible indexers for ${type}`);

    // FAST TIER: Top priority indexers (priority > 60)
    const fastIndexers = sortedIndexers.filter(idx => idx.priority > 60).slice(0, 8);
    const slowIndexers = sortedIndexers.filter(idx => idx.priority <= 60).slice(0, 10);

    // PARALLEL EXECUTION: Fast Tier + Custom Scrapers
    // This ensures we get high-quality results from popular indexers AND specialty results from custom ones
    // without one blocking the other or race conditions causing data loss.
    const initialPromises = [];

    // 1. Fast Tier
    if (fastIndexers.length > 0) {
        console.log(`[RealTime] Fast tier: ${fastIndexers.map(i => i.id).join(', ')}`);
        initialPromises.push(searchIndexerBatch(fastIndexers, params));
    }

    // 2. Custom Scrapers (Always run these)
    initialPromises.push(runCustomScrapers(params));

    // Wait for both to finish
    const [fastResults, customResults] = await Promise.all(
        initialPromises.map(p => p.catch(e => [])) // Catch individual errors so Promise.all doesn't fail
    );

    if (fastResults && fastResults.length > 0) allResults.push(...fastResults);
    if (customResults && customResults.length > 0) allResults.push(...customResults);

    // Check if we need more results
    const totalSoFar = allResults.length;
    console.log(`[RealTime] Initial batch yielded ${totalSoFar} results`);

    if (totalSoFar >= 10) {
        console.log(`[RealTime] Sufficient results found, skipping slow tier`);
        return allResults;
    }

    // Run slow tier if needed
    if (slowIndexers.length > 0) {
        console.log(`[RealTime] Slow tier: ${slowIndexers.map(i => i.id).join(', ')}`);
        const slowResults = await searchIndexerBatch(slowIndexers, params);
        allResults.push(...slowResults);
    }

    console.log(`[RealTime] Total results: ${allResults.length}`);
    return allResults;
}

/**
 * Search a batch of indexers in parallel
 */
async function searchIndexerBatch(indexers, params) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const promises = [];

    for (const indexer of indexers) {
        const indexerId = indexer.id;
        const workingDomain = indexer.workingDomain;

        // Check if we have a legacy scraper for this indexer
        if (LEGACY_SCRAPERS[indexerId]) {
            const scraper = LEGACY_SCRAPERS[indexerId];

            // Check if scraper supports this content type
            if (!scraper.types.includes(type)) continue;

            // Use legacy scraper with working domain hint
            promises.push(
                runLegacyScraper(indexerId, scraper, params, workingDomain)
                    .catch(err => {
                        console.log(`[RealTime] ${indexerId} failed: ${err.message}`);
                        return [];
                    })
            );
        } else {
            // Use Cardigann engine for this indexer
            promises.push(
                searchWithCardigann(indexerId, title || imdbId, {
                    imdbId,
                    type,
                    season,
                    episode,
                    workingDomain
                }).catch(err => {
                    console.log(`[RealTime] ${indexerId} (Cardigann) failed: ${err.message}`);
                    return [];
                })
            );
        }
    }

    const results = await Promise.allSettled(promises);
    const torrents = [];

    for (const result of results) {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            torrents.push(...result.value);
        }
    }

    return torrents;
}

/**
 * Run a legacy scraper with optional domain hint
 */
async function runLegacyScraper(indexerId, scraper, params, workingDomain) {
    const { imdbId, kitsuId, type, season, episode, title } = params;

    // Check for cached CF session
    let cfSession = null;
    if (workingDomain) {
        try {
            const domain = new URL(workingDomain).hostname;
            cfSession = await getCachedSession(domain);
        } catch (e) { }
    }

    // Call the appropriate scraper based on type
    switch (indexerId) {
        case 'yts':
            return scraper.search(imdbId);
        case 'eztv':
            return scraper.search(imdbId, season, episode);
        case 'nyaasi':
            return scraper.search(kitsuId, title, episode);
        case '1337x':
        case 'torrentgalaxyclone':
            return scraper.search(imdbId, type);
        case 'bitsearch':
            // Pass CF session if available
            return scraper.search(imdbId || title, !cfSession);
        default:
            return scraper.search(imdbId || title);
    }
}

/**
 * Run custom scrapers (not in Prowlarr)
 */
async function runCustomScrapers(params) {
    const { imdbId, kitsuId, type, title } = params;
    const promises = [];

    for (const [id, scraper] of Object.entries(CUSTOM_SCRAPERS)) {
        if (!scraper.types.includes(type)) continue;

        promises.push(
            scraper.search(imdbId || title, true)
                .catch(err => {
                    console.log(`[RealTime] ${id} failed: ${err.message}`);
                    return [];
                })
        );
    }

    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value || []);
}



/**
 * Legacy tiered search (fallback when no health data)
 */
async function searchLegacy(params) {
    const { imdbId, kitsuId, type, season, episode, title } = params;

    // FAST TIER
    const fastResults = await runFastTierLegacy(params);
    if (fastResults.length > 0) {
        console.log(`[RealTime] Legacy fast tier returned ${fastResults.length} results`);
        return fastResults;
    }

    // SLOW TIER
    console.log(`[RealTime] Legacy fast tier empty, running slow tier...`);
    return runSlowTierLegacy(params);
}

async function runFastTierLegacy(params) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const promises = [];

    if (type === 'movie' && imdbId) {
        promises.push(searchYTS(imdbId));
    }

    if (type === 'series' && imdbId) {
        promises.push(searchEZTV(imdbId, season, episode));
    }

    if ((type === 'anime' || kitsuId) && title) {
        promises.push(searchNyaa(kitsuId, title, episode));
    }

    if (imdbId) {
        promises.push(searchBitSearch(imdbId, true));
        promises.push(searchSolidTorrents(imdbId, true));
    } else if (title) {
        promises.push(searchBitSearch(title, true));
        promises.push(searchSolidTorrents(title, true));
    }

    if (promises.length === 0) return [];

    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value || []);
}

async function runSlowTierLegacy(params) {
    const { imdbId, type, title } = params;
    const promises = [];

    if (imdbId) {
        promises.push(search1337x(imdbId, type));
        promises.push(searchTorrentGalaxy(imdbId, type));
        promises.push(searchBitSearch(imdbId, false));
        promises.push(searchSolidTorrents(imdbId, false));
    } else if (title) {
        promises.push(searchBitSearch(title, false));
        promises.push(searchSolidTorrents(title, false));
    }

    if (promises.length === 0) return [];

    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value || []);
}

/**
 * Deduplicate torrents by infoHash
 */
export function deduplicateTorrents(torrents) {
    const seen = new Set();
    return torrents.filter(t => {
        if (!t.infoHash || seen.has(t.infoHash)) return false;
        seen.add(t.infoHash);
        return true;
    });
}

export default { searchTorrents, deduplicateTorrents };
