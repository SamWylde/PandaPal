/**
 * Torrentio Scraper
 *
 * Queries Torrentio's pre-built database via their public API.
 * Uses FlareSolverr to bypass Cloudflare protection.
 *
 * This gives us access to their massive pre-verified torrent database
 * with accurate IMDB mappings - no title matching needed!
 */

import { fetchWithCFBypass, isAvailable as isFlareSolverrAvailable } from '../flareSolverr.js';

const TORRENTIO_BASE = 'https://torrentio.strem.fun';

// Cache for results (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Parse Torrentio stream title to extract metadata
 * Format: "Tracker\n👤 seeders 💾 size ⚙️ source"
 * @param {string} title - Raw stream title
 * @returns {object} Parsed metadata
 */
function parseStreamTitle(title) {
    const lines = title.split('\n');
    const metadata = {
        quality: null,
        seeders: 0,
        size: null,
        source: null
    };

    // First line usually has quality info
    if (lines[0]) {
        const qualityMatch = lines[0].match(/\b(4K|2160p|1080p|720p|480p|HDR|DV|Dolby Vision)\b/i);
        if (qualityMatch) {
            metadata.quality = qualityMatch[1].toUpperCase();
        }
    }

    // Parse emoji-prefixed values
    const fullTitle = title;

    // Seeders: 👤 123
    const seedersMatch = fullTitle.match(/👤\s*(\d+)/);
    if (seedersMatch) {
        metadata.seeders = parseInt(seedersMatch[1], 10);
    }

    // Size: 💾 1.5 GB
    const sizeMatch = fullTitle.match(/💾\s*([\d.]+\s*[GMKT]B)/i);
    if (sizeMatch) {
        metadata.size = sizeMatch[1];
    }

    // Source/tracker: ⚙️ YTS or [YTS]
    const sourceMatch = fullTitle.match(/⚙️\s*(\w+)/);
    if (sourceMatch) {
        metadata.source = sourceMatch[1];
    } else {
        // Try bracket format [YTS]
        const bracketMatch = lines[0]?.match(/\[(\w+)\]/);
        if (bracketMatch) {
            metadata.source = bracketMatch[1];
        }
    }

    return metadata;
}

/**
 * Convert size string to bytes
 * @param {string} sizeStr - e.g., "1.5 GB"
 * @returns {number} Size in bytes
 */
function parseSize(sizeStr) {
    if (!sizeStr) return 0;

    const match = sizeStr.match(/([\d.]+)\s*([GMKT]B)/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    const multipliers = {
        'TB': 1024 * 1024 * 1024 * 1024,
        'GB': 1024 * 1024 * 1024,
        'MB': 1024 * 1024,
        'KB': 1024
    };

    return Math.round(value * (multipliers[unit] || 1));
}

/**
 * Search Torrentio for a movie or series
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @param {string} type - "movie" or "series"
 * @param {object} options - Additional options
 * @param {number} options.season - Season number (for series)
 * @param {number} options.episode - Episode number (for series)
 * @returns {Promise<Array>} Array of torrent results
 */
export async function searchTorrentio(imdbId, type = 'movie', options = {}) {
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('[Torrentio] Invalid IMDB ID:', imdbId);
        return [];
    }

    // Build media ID
    let mediaId = imdbId;
    if (type === 'series' && options.season && options.episode) {
        mediaId = `${imdbId}:${options.season}:${options.episode}`;
    }

    // Check cache
    const cacheKey = `${type}:${mediaId}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        console.log(`[Torrentio] Cache hit for ${mediaId}`);
        return cached.results;
    }

    // Check if FlareSolverr is available
    const flareSolverrReady = await isFlareSolverrAvailable();
    if (!flareSolverrReady) {
        console.log('[Torrentio] FlareSolverr not available, skipping');
        return [];
    }

    const url = `${TORRENTIO_BASE}/stream/${type}/${mediaId}.json`;
    console.log(`[Torrentio] Fetching: ${url}`);

    try {
        const startTime = Date.now();
        const response = await fetchWithCFBypass(url, { timeout: 30000 });

        if (!response.success) {
            console.log(`[Torrentio] FlareSolverr failed: ${response.error}`);
            return [];
        }

        // Parse JSON from HTML response
        let data;
        try {
            // FlareSolverr returns the page content as HTML, but for JSON endpoints
            // it should be the raw JSON
            const html = response.html || '';

            // Try to extract JSON from the response
            // Sometimes FlareSolverr wraps it in HTML, sometimes it's raw
            if (html.startsWith('{') || html.startsWith('[')) {
                data = JSON.parse(html);
            } else {
                // Try to find JSON in the HTML
                const jsonMatch = html.match(/\{[\s\S]*"streams"[\s\S]*\}/);
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[0]);
                } else {
                    console.log('[Torrentio] Could not find JSON in response');
                    return [];
                }
            }
        } catch (parseError) {
            console.log('[Torrentio] JSON parse error:', parseError.message);
            return [];
        }

        const elapsed = Date.now() - startTime;
        const streams = data.streams || [];

        console.log(`[Torrentio] Found ${streams.length} streams in ${elapsed}ms`);

        // Convert Torrentio format to our standard format
        const results = streams.map(stream => {
            const metadata = parseStreamTitle(stream.title || stream.name || '');

            // Extract infoHash from the stream URL or behaviorHints
            let infoHash = null;
            if (stream.infoHash) {
                infoHash = stream.infoHash.toLowerCase();
            } else if (stream.url) {
                // URL format: magnet:?xt=urn:btih:HASH&...
                const hashMatch = stream.url.match(/btih:([a-f0-9]{40})/i);
                if (hashMatch) {
                    infoHash = hashMatch[1].toLowerCase();
                }
            }

            return {
                title: stream.title || stream.name || 'Unknown',
                infoHash: infoHash,
                magnetLink: stream.url || null,
                seeders: metadata.seeders,
                size: parseSize(metadata.size),
                sizeHuman: metadata.size,
                quality: metadata.quality,
                source: metadata.source || 'Torrentio',
                imdbId: imdbId, // Torrentio results are pre-verified for this IMDB!
                type: type,
                fromTorrentio: true // Flag to indicate trusted source
            };
        }).filter(r => r.infoHash); // Only keep results with valid hashes

        // Cache results
        cache.set(cacheKey, { results, time: Date.now() });

        return results;
    } catch (error) {
        console.error('[Torrentio] Error:', error.message);
        return [];
    }
}

/**
 * Search wrapper that matches our standard interface
 * @param {string} query - Search query (ignored, we use imdbId)
 * @param {string} type - "movie" or "series"
 * @param {object} options - Options including imdbId
 * @returns {Promise<Array>}
 */
export async function search(query, type, options = {}) {
    // Torrentio ONLY works with IMDB IDs
    if (!options.imdbId) {
        console.log('[Torrentio] No IMDB ID provided, skipping');
        return [];
    }

    return searchTorrentio(options.imdbId, type, options);
}

export default {
    search,
    searchTorrentio
};
