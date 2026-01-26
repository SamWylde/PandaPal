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

// FAST MODE: Reduced timeout for snappy UX
// If scrapers are blocked, fail fast instead of waiting for FlareSolverr
const MAX_SEARCH_TIMEOUT_MS = 15000; // 15 seconds max for entire search

// Title cache to avoid repeated API calls
const titleCache = new Map();
const TITLE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Resolve IMDB ID to title using Stremio's Cinemeta API
 * @param {string} imdbId - IMDB ID (e.g., tt1234567)
 * @param {string} type - Content type (movie or series)
 * @returns {Promise<string|null>} - Resolved title or null
 */
async function resolveImdbTitle(imdbId, type) {
    if (!imdbId || !imdbId.startsWith('tt')) return null;

    // Check cache first
    const cacheKey = `${imdbId}:${type}`;
    const cached = titleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TITLE_CACHE_TTL) {
        return cached.title;
    }

    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.log(`[RealTime] Cinemeta returned ${response.status} for ${imdbId}`);
            return null;
        }

        const data = await response.json();
        const title = data?.meta?.name || null;

        if (title) {
            // Cache the result
            titleCache.set(cacheKey, { title, timestamp: Date.now() });
            console.log(`[RealTime] Resolved ${imdbId} to title: "${title}"`);
        }

        return title;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log(`[RealTime] Cinemeta request timed out for ${imdbId}`);
        } else {
            console.log(`[RealTime] Failed to resolve ${imdbId}: ${err.message}`);
        }
        return null;
    }
}

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
 * Uses DB content types (from Prowlarr YAML) first, falls back to hardcoded map
 * @param {string} indexerId - Indexer ID
 * @param {string} contentType - Content type (movie, series, anime)
 * @param {string[]|null} dbContentTypes - Content types from database (optional)
 */
function indexerSupportsType(indexerId, contentType, dbContentTypes = null) {
    // Priority 1: Use database content types if available
    if (dbContentTypes && Array.isArray(dbContentTypes)) {
        // Empty array means indexer explicitly doesn't support any content (adult/games)
        if (dbContentTypes.length === 0) return false;
        return dbContentTypes.includes(contentType);
    }

    // Priority 2: Use hardcoded map as fallback
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
    const { imdbId, kitsuId, type, season, episode, providers, config } = params;
    let { title } = params;

    // If no title provided but we have IMDB ID, resolve it via Cinemeta
    // CRITICAL: This is essential for filtering garbage results from bad indexers
    if (!title && imdbId) {
        const resolvedTitle = await resolveImdbTitle(imdbId, type);
        if (resolvedTitle) {
            title = resolvedTitle;
            // Update params so title propagates to all search functions
            params = { ...params, title };
        }
    }

    const searchQuery = title || imdbId || kitsuId;
    console.log(`[RealTime] Starting search for ${searchQuery} (${type})`);

    // Update params with resolved title for downstream use
    const searchParams = { ...params, title };

    // Check if user selected specific providers or wants smart mode
    const useSmartMode = !providers || providers.length === 0 || providers.includes('smart');
    const selectedProviders = providers?.filter(p => p !== 'smart') || [];

    let results = [];

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
            results = await searchWithPriority(searchParams, prioritizedIndexers);
        } else {
            // Fallback to legacy tiered approach
            console.log(`[RealTime] No health data, falling back to legacy search`);
            results = await searchLegacy(searchParams);
        }
    } else {
        // Manual provider selection - use only selected providers
        console.log(`[RealTime] Using MANUAL mode with providers: ${selectedProviders.join(', ')}`);
        results = await searchSelectedProviders(searchParams, selectedProviders);
    }

    // CRITICAL: Filter results by title relevance
    // This removes garbage results from indexers that return homepage listings
    // instead of actual search results (e.g., arab-torrents returning "One Piece"
    // when we searched for "One Fast Move")
    if (title && results.length > 0) {
        results = filterByRelevance(results, title, imdbId);
    }

    return results;
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
                    scraper.search(title || imdbId, true)
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
    // Uses DB content types (extracted from Prowlarr YAML) with hardcoded fallback
    // This prevents anime/hentai/game indexers from being searched for movies
    const compatibleIndexers = indexers.filter(idx =>
        indexerSupportsType(idx.id, type, idx.contentTypes)
    );
    const incompatibleCount = indexers.length - compatibleIndexers.length;

    if (incompatibleCount > 0) {
        const filtered = indexers.filter(idx => !indexerSupportsType(idx.id, type, idx.contentTypes));
        console.log(`[RealTime] Filtered out ${incompatibleCount} indexers incompatible with "${type}": ${filtered.map(i => i.id).join(', ')}`);
    }

    if (compatibleIndexers.length === 0) {
        console.log(`[RealTime] No compatible indexers for type "${type}", falling back to legacy`);
        return searchLegacy(params);
    }

    // Sort by priority (best first), but CF-free indexers always go first
    // requiresSolver: false = CF-free (fast), true = needs FlareSolverr (slow)
    const sortedIndexers = compatibleIndexers.sort((a, b) => {
        // CF-free indexers come first
        if (a.requiresSolver === false && b.requiresSolver !== false) return -1;
        if (b.requiresSolver === false && a.requiresSolver !== false) return 1;
        // Then sort by priority
        return b.priority - a.priority;
    });

    // Separate CF-free indexers from those that need FlareSolverr
    const cfFreeIndexers = sortedIndexers.filter(idx => idx.requiresSolver === false);
    const cfBlockedIndexers = sortedIndexers.filter(idx => idx.requiresSolver !== false);

    console.log(`[RealTime] Found ${cfFreeIndexers.length} CF-free indexers, ${cfBlockedIndexers.length} need solver`);
    console.log(`[RealTime] Searching ${sortedIndexers.length} compatible indexers for ${type}`);

    // FAST TIER: CF-free indexers first (these respond in ~1-2 seconds)
    // Only use CF-blocked indexers if we don't have enough CF-free ones
    const fastIndexers = cfFreeIndexers.slice(0, 8);
    const slowIndexers = cfBlockedIndexers.slice(0, 5); // Limited slow tier since they need solver

    // PARALLEL EXECUTION: Fast Tier + Legacy Scrapers + Custom Scrapers
    // Legacy scrapers (YTS, 1337x, etc.) are NOT in the health database,
    // so we ALWAYS run them alongside the health-prioritized Cardigann indexers.
    const initialPromises = [];

    // 1. Fast Tier (CF-free Cardigann indexers - no waiting for solver)
    if (fastIndexers.length > 0) {
        console.log(`[RealTime] Fast tier (CF-free): ${fastIndexers.map(i => i.id).join(', ')}`);
        initialPromises.push(searchIndexerBatch(fastIndexers, params));
    }

    // 2. Legacy Scrapers (YTS, 1337x, TorrentGalaxy, EZTV, etc.) - ALWAYS run these
    initialPromises.push(runAllLegacyScrapers(params));

    // 3. Custom Scrapers (SolidTorrents, etc.) - ALWAYS run these
    initialPromises.push(runCustomScrapers(params));

    // Wait for all to finish
    const results = await Promise.all(
        initialPromises.map(p => p.catch(e => [])) // Catch individual errors so Promise.all doesn't fail
    );

    // Flatten all results
    for (const result of results) {
        if (result && result.length > 0) allResults.push(...result);
    }

    // Check if we need more results
    const totalSoFar = allResults.length;
    console.log(`[RealTime] Initial batch yielded ${totalSoFar} results`);

    if (totalSoFar >= 10) {
        console.log(`[RealTime] Sufficient results found, skipping slow tier`);
        return allResults;
    }

    // Run slow tier if needed (CF-blocked indexers - would need solver but we skip it for speed)
    if (slowIndexers.length > 0) {
        console.log(`[RealTime] Slow tier (CF-blocked, skipping): ${slowIndexers.map(i => i.id).join(', ')}`);
        // NOTE: We don't actually run these in fast mode since they'd need FlareSolverr
        // const slowResults = await searchIndexerBatch(slowIndexers, params);
        // allResults.push(...slowResults);
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
    // Prefer title over IMDB ID for scrapers that search by text
    switch (indexerId) {
        case 'yts':
            // YTS API natively supports IMDB IDs
            return scraper.search(imdbId);
        case 'eztv':
            // EZTV API natively supports IMDB IDs
            return scraper.search(imdbId, season, episode);
        case 'nyaasi':
            return scraper.search(kitsuId, title, episode);
        case '1337x':
        case 'torrentgalaxyclone':
            // These sites search by text, so prefer title over IMDB ID
            return scraper.search(title || imdbId, type);
        case 'bitsearch':
            // Pass CF session if available, prefer title
            return scraper.search(title || imdbId, !cfSession);
        default:
            return scraper.search(title || imdbId);
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

        // Custom scrapers search by text, so prefer title over IMDB ID
        promises.push(
            scraper.search(title || imdbId, true)
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
 * Run ALL legacy scrapers (YTS, 1337x, TorrentGalaxy, EZTV, etc.)
 * These are hardcoded JavaScript scrapers NOT tracked by health checks.
 * They're popular and reliable, so we ALWAYS run them in SMART mode.
 */
async function runAllLegacyScrapers(params) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const promises = [];

    console.log(`[RealTime] Running legacy scrapers for ${type}`);

    for (const [id, scraper] of Object.entries(LEGACY_SCRAPERS)) {
        // Skip if scraper doesn't support this content type
        if (!scraper.types.includes(type)) continue;

        // Run the scraper with appropriate parameters
        const searchPromise = runLegacyScraper(id, scraper, params, null)
            .catch(err => {
                console.log(`[RealTime] Legacy ${id} failed: ${err.message}`);
                return [];
            });

        promises.push(searchPromise);
    }

    if (promises.length === 0) {
        return [];
    }

    const results = await Promise.allSettled(promises);
    const torrents = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value || []);

    console.log(`[RealTime] Legacy scrapers returned ${torrents.length} results`);
    return torrents;
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

/**
 * Filter torrents by title relevance
 * Removes results that don't match the search query
 *
 * CRITICAL: This prevents garbage results from indexers that return
 * homepage listings or unrelated content instead of actual search results.
 *
 * @param {Array} torrents - Array of torrent objects
 * @param {string} searchTitle - The title we searched for
 * @param {string} imdbId - Optional IMDB ID (some torrents have this in title)
 * @returns {Array} Filtered torrents that match the search
 */
export function filterByRelevance(torrents, searchTitle, imdbId = null) {
    if (!searchTitle && !imdbId) return torrents;
    if (!torrents || torrents.length === 0) return torrents;

    // Normalize search title: lowercase, remove special chars, split into words
    const normalizeTitle = (title) => {
        if (!title) return [];
        return title
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')  // Remove punctuation
            .replace(/\s+/g, ' ')       // Normalize whitespace
            .trim()
            .split(' ')
            .filter(w => w.length > 1); // Remove single chars
    };

    // Get search keywords (ignore common words)
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'is', 'it']);
    const searchWords = normalizeTitle(searchTitle).filter(w => !stopWords.has(w));

    // If we only have stop words or nothing, allow everything
    if (searchWords.length === 0 && !imdbId) return torrents;

    // For short titles (1-2 significant words), require ALL words to match
    // For longer titles (3+ words), require at least 60% of words to match
    const minMatchRatio = searchWords.length <= 2 ? 1.0 : 0.6;
    const minMatches = Math.max(1, Math.ceil(searchWords.length * minMatchRatio));

    const filtered = torrents.filter(torrent => {
        const torrentTitle = torrent.title || torrent.name || '';
        const normalizedTorrent = torrentTitle.toLowerCase();

        // If torrent has IMDB ID and it matches, always include
        if (imdbId && torrent.imdbId === imdbId) return true;

        // Check if IMDB ID appears in torrent title
        if (imdbId && normalizedTorrent.includes(imdbId.toLowerCase())) return true;

        // Count matching words
        let matches = 0;
        for (const word of searchWords) {
            // Check if word appears in torrent title
            // Use word boundary check to avoid partial matches (e.g., "one" matching "stone")
            const wordRegex = new RegExp(`\\b${word}\\b`, 'i');
            if (wordRegex.test(torrentTitle)) {
                matches++;
            }
        }

        return matches >= minMatches;
    });

    // Log filtering stats
    const removed = torrents.length - filtered.length;
    if (removed > 0) {
        console.log(`[RealTime] Title filter: kept ${filtered.length}/${torrents.length} results matching "${searchTitle}" (removed ${removed} irrelevant)`);
    }

    return filtered;
}

export default { searchTorrents, deduplicateTorrents, filterByRelevance };
