import axios from 'axios';

const YTS_API_BASE = 'https://yts.mx/api/v2';

/**
 * Search YTS for movies by IMDB ID
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchYTS(imdbId) {
    try {
        const response = await axios.get(`${YTS_API_BASE}/list_movies.json`, {
            params: { query_term: imdbId },
            timeout: 5000
        });

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
        console.error(`YTS search failed for ${imdbId}:`, error.message);
        return [];
    }
}

export default { searchYTS };
