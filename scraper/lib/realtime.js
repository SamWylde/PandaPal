/**
 * Real-time Torrent Search
 *
 * Uses health-prioritized indexers from the database.
 * Falls back to legacy scrapers if health data unavailable.
 *
 * Indexers are sorted by priority (calculated from success rate + speed).
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

// Indexers known to work well for specific content types
const TYPE_PREFERENCES = {
    movie: ['yts', '1337x', 'torrentgalaxyclone', 'thepiratebay', 'limetorrents', 'bitsearch'],
    series: ['eztv', '1337x', 'torrentgalaxyclone', 'thepiratebay', 'showrss', 'bitsearch'],
    anime: ['nyaasi', 'tokyotosho', 'anisource', 'shanaproject', 'dmhy', 'acgrip']
};

/**
 * Real-time torrent search with health-prioritized indexers
 */
export async function searchTorrents(params) {
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
 */
async function searchWithPriority(params, indexers) {
    const { imdbId, kitsuId, type, season, episode, title } = params;
    const allResults = [];

    // Filter indexers by content type preference
    const typePrefs = TYPE_PREFERENCES[type] || [];
    const preferredIndexers = indexers.filter(idx =>
        typePrefs.includes(idx.id) || idx.priority > 50
    );
    const otherIndexers = indexers.filter(idx =>
        !typePrefs.includes(idx.id) && idx.priority <= 50
    );

    // Sort: type-preferred first, then by priority
    const sortedIndexers = [
        ...preferredIndexers.sort((a, b) => b.priority - a.priority),
        ...otherIndexers.sort((a, b) => b.priority - a.priority)
    ];

    console.log(`[RealTime] Searching ${sortedIndexers.length} indexers (${preferredIndexers.length} preferred for ${type})`);

    // FAST TIER: Top priority indexers (priority > 60)
    const fastIndexers = sortedIndexers.filter(idx => idx.priority > 60).slice(0, 8);
    const slowIndexers = sortedIndexers.filter(idx => idx.priority <= 60).slice(0, 10);

    // Run fast tier
    if (fastIndexers.length > 0) {
        console.log(`[RealTime] Fast tier: ${fastIndexers.map(i => i.id).join(', ')}`);
        const fastResults = await searchIndexerBatch(fastIndexers, params);
        allResults.push(...fastResults);

        // Return early if we have good results
        if (fastResults.length >= 10) {
            console.log(`[RealTime] Fast tier returned ${fastResults.length} results, skipping slow tier`);
            // Still add custom scrapers in background
            addCustomScrapersAsync(params, allResults);
            return allResults;
        }
    }

    // Run slow tier
    if (slowIndexers.length > 0) {
        console.log(`[RealTime] Slow tier: ${slowIndexers.map(i => i.id).join(', ')}`);
        const slowResults = await searchIndexerBatch(slowIndexers, params);
        allResults.push(...slowResults);
    }

    // Always run custom scrapers (solidtorrents, etc.)
    const customResults = await runCustomScrapers(params);
    allResults.push(...customResults);

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
 * Add custom scrapers asynchronously (non-blocking)
 */
function addCustomScrapersAsync(params, resultsArray) {
    runCustomScrapers(params)
        .then(results => {
            resultsArray.push(...results);
        })
        .catch(err => {
            console.log(`[RealTime] Custom scrapers error: ${err.message}`);
        });
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
