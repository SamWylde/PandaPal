import axios from 'axios';

// Fallback domains for YTS in case primary fails
const YTS_DOMAINS = [
    'https://yts.mx/api/v2',
    'https://yts.lt/api/v2',
    'https://yts.am/api/v2'
];

/**
 * Retry helper with exponential backoff
 */
async function retryWithBackoff(fn, retries = 2, delay = 1000) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}

/**
 * Search YTS for movies by IMDB ID
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchYTS(imdbId) {
    // Try each domain with retry logic
    for (const apiBase of YTS_DOMAINS) {
        try {
            const response = await retryWithBackoff(() =>
                axios.get(`${apiBase}/list_movies.json`, {
                    params: { query_term: imdbId },
                    timeout: 5000
                })
            );

            const movies = response.data?.data?.movies || [];
            const torrents = [];

            for (const movie of movies) {
                if (!movie.torrents) continue;

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
            console.log(`YTS (${apiBase}): Failed, trying next domain...`);
            continue;
        }
    }

    console.error(`YTS search failed for ${imdbId}: All domains exhausted`);
    return [];
}

export default { searchYTS };
