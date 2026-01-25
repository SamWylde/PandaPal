import axios from 'axios';
import { getScraperConfig } from '../db.js';

// Fallback domains for YTS
const YTS_FALLBACK = [
    'https://yts.mx/api/v2',
    'https://yts.lt/api/v2',
    'https://yts.am/api/v2'
];

let cachedDomains = null;

async function getDomains() {
    if (cachedDomains) return cachedDomains;

    try {
        const config = await getScraperConfig('yts');
        if (config && config.domains && Array.isArray(config.domains) && config.domains.length > 0) {
            cachedDomains = config.domains;
            console.log(`[YTS] Loaded ${cachedDomains.length} domains from DB`);
        } else {
            cachedDomains = YTS_FALLBACK;
            console.log(`[YTS] Using fallback domains`);
        }
    } catch (e) {
        console.error(`[YTS] Failed to load config: ${e.message}`);
        cachedDomains = YTS_FALLBACK;
    }

    return cachedDomains;
}

/**
 * Format error details for debugging
 */
function formatErrorDetails(error, url) {
    const details = {
        url,
        message: error.message,
        code: error.code || 'UNKNOWN'
    };

    if (error.response) {
        details.status = error.response.status;
        details.statusText = error.response.statusText;
        details.headers = {
            'content-type': error.response.headers?.['content-type'],
            'cf-ray': error.response.headers?.['cf-ray'] // Cloudflare ray ID
        };
        // Include truncated response body for debugging
        if (typeof error.response.data === 'string') {
            details.responsePreview = error.response.data.substring(0, 200);
        } else if (error.response.data) {
            details.responseData = JSON.stringify(error.response.data).substring(0, 200);
        }
    } else if (error.request) {
        details.type = 'NO_RESPONSE';
        details.timeout = error.code === 'ECONNABORTED';
    }

    return details;
}

/**
 * Retry helper with exponential backoff and detailed logging
 */
async function retryWithBackoff(fn, retries = 2, delay = 1000, context = '') {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            const attempt = i + 1;
            const isLastAttempt = i === retries;

            if (!isLastAttempt) {
                const waitTime = delay * Math.pow(2, i);
                console.log(`YTS [${context}]: Attempt ${attempt}/${retries + 1} failed (${error.code || error.message}), retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Search YTS for movies by IMDB ID
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchYTS(imdbId) {
    const errors = [];
    const domains = await getDomains();

    // Try each domain with retry logic
    for (const apiBase of domains) {
        const requestUrl = `${apiBase}/list_movies.json?query_term=${imdbId}`;
        try {
            const response = await retryWithBackoff(
                () => axios.get(`${apiBase}/list_movies.json`, {
                    params: { query_term: imdbId },
                    timeout: 5000
                }),
                2,
                1000,
                apiBase
            );

            // Validate response structure
            if (!response.data) {
                throw new Error('Empty response body');
            }

            if (response.data.status !== 'ok') {
                console.warn(`YTS (${apiBase}): API returned non-ok status: ${response.data.status}, message: ${response.data.status_message || 'none'}`);
            }

            const movies = response.data?.data?.movies || [];
            const movieCount = response.data?.data?.movie_count || 0;

            console.log(`YTS (${apiBase}): API response - movie_count: ${movieCount}, movies array length: ${movies.length}`);

            const torrents = [];

            for (const movie of movies) {
                if (!movie.torrents) {
                    console.log(`YTS: Movie "${movie.title}" has no torrents array`);
                    continue;
                }

                for (const torrent of movie.torrents) {
                    torrents.push({
                        infoHash: torrent.hash?.toLowerCase(),
                        provider: 'yts',
                        title: `${movie.title} (${movie.year}) [${torrent.quality}] [${torrent.type}]`,
                        size: torrent.size_bytes,
                        type: 'movie',
                        uploadDate: new Date(torrent.date_uploaded_unix * 1000),
                        seeders: torrent.seeds,
                        resolution: torrent.quality,
                        imdbId: imdbId,
                        magnetUrl: `magnet:?xt=urn:btih:${torrent.hash}`
                    });
                }
            }

            console.log(`YTS: Found ${torrents.length} torrents for ${imdbId}`);
            return torrents;
        } catch (error) {
            const errorDetails = formatErrorDetails(error, requestUrl);
            errors.push({ domain: apiBase, ...errorDetails });
            console.log(`YTS (${apiBase}): Failed - ${error.code || 'ERROR'}: ${error.message}${error.response ? ` [HTTP ${error.response.status}]` : ''}`);
            continue;
        }
    }

    console.error(`YTS search failed for ${imdbId}: All domains exhausted`);
    console.error(`YTS error details: ${JSON.stringify(errors, null, 2)}`);
    return [];
}

export default { searchYTS };
