/**
 * Metadata Resolution Module
 *
 * Resolves IMDB IDs to titles using Stremio's Cinemeta API.
 * CRITICAL for filtering garbage search results by title relevance.
 */

import axios from 'axios';

// Cinemeta API (Stremio's official metadata source)
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

// Simple in-memory cache for title lookups
const titleCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Resolve IMDB ID to title using Cinemeta
 *
 * @param {string} imdbId - IMDB ID (e.g., "tt21096576")
 * @param {string} type - Content type ("movie" or "series")
 * @returns {Promise<string|null>} Resolved title or null
 */
export async function resolveTitle(imdbId, type = 'movie') {
    if (!imdbId) return null;

    // Check cache first
    const cacheKey = `${imdbId}:${type}`;
    const cached = titleCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        return cached.title;
    }

    try {
        const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'User-Agent': 'PandaPal/1.0'
            }
        });

        const title = response.data?.meta?.name || null;

        if (title) {
            console.log(`[RealTime] Resolved ${imdbId} to title: "${title}"`);

            // Cache the result
            titleCache.set(cacheKey, {
                title,
                expires: Date.now() + CACHE_TTL
            });
        }

        return title;
    } catch (error) {
        console.warn(`[Metadata] Failed to resolve ${imdbId}: ${error.message}`);
        return null;
    }
}

/**
 * Get year from IMDB metadata
 */
export async function resolveMetadata(imdbId, type = 'movie') {
    if (!imdbId) return null;

    try {
        const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'User-Agent': 'PandaPal/1.0'
            }
        });

        const meta = response.data?.meta;
        if (!meta) return null;

        return {
            title: meta.name,
            year: meta.releaseInfo?.split('–')?.[0] || meta.year,
            genres: meta.genres || []
        };
    } catch (error) {
        console.warn(`[Metadata] Failed to get metadata for ${imdbId}: ${error.message}`);
        return null;
    }
}

export default { resolveTitle, resolveMetadata };
