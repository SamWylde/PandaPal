import { searchYTS } from './sources/yts.js';
import { searchEZTV } from './sources/eztv.js';
import { searchNyaa } from './sources/nyaa.js';
import { search1337x } from './sources/t1337x.js';
import { searchTorrentGalaxy } from './sources/torrentgalaxy.js';
import { searchBitSearch } from './sources/bitsearch.js';
import { searchSolidTorrents } from './sources/solidtorrents.js';

/**
 * Real-time torrent search with tiered approach
 * Fast tier first, slow tier if nothing found
 * 
 * @param {Object} params - Search parameters
 * @param {string} params.imdbId - IMDB ID (for movies/series)
 * @param {string} params.kitsuId - Kitsu ID (for anime)
 * @param {string} params.type - 'movie', 'series', or 'anime'
 * @param {number} params.season - Season number (for series)
 * @param {number} params.episode - Episode number (for series)
 * @param {string} params.title - Title (fallback for anime)
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchTorrents(params) {
    const { imdbId, kitsuId, type, season, episode, title } = params;

    console.log(`[RealTime] Starting search for ${imdbId || kitsuId || title} (${type})`);

    // FAST TIER: APIs & Light Scrapers (1-5 seconds)
    const fastResults = await runFastTier(params);

    // If we have enough results, return early to be responsive
    // But since BitSearch/Solid are good backups, we might wait for them 
    // "Fast Tier" now includes them.
    if (fastResults.length > 0) {
        console.log(`[RealTime] Fast tier returned ${fastResults.length} results`);
        return fastResults;
    }

    // SLOW TIER: Heavy Scrapers / Browser Bypass (5-30 seconds)
    console.log(`[RealTime] Fast tier empty, running slow tier (Browser/Cloudflare bypass)...`);
    const slowResults = await runSlowTier(params);

    console.log(`[RealTime] Total results: ${slowResults.length}`);
    return slowResults;
}

async function runFastTier(params) {
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

    // Add new independent scrapers to fast tier as they are usually fast
    // We search by IMDB ID if possible, otherwise by title if we had one (but we mainly have imdbId for standard content)
    // BitSearch and SolidTorrents work best with text queries, so we use IMDB ID as query for precision
    if (imdbId) {
        promises.push(searchBitSearch(imdbId));
        promises.push(searchSolidTorrents(imdbId));
    } else if (title) {
        promises.push(searchBitSearch(title));
        promises.push(searchSolidTorrents(title));
    }

    if (promises.length === 0) {
        return [];
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

async function runSlowTier(params) {
    const { imdbId, type } = params;

    if (!imdbId) {
        return [];
    }

    // These natively handle Cloudflare bypassing now via browser.js
    const promises = [
        search1337x(imdbId, type),
        searchTorrentGalaxy(imdbId, type)
    ];

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
