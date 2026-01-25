import axios from 'axios';
import { getScraperConfig } from '../db.js';

const EZTV_FALLBACK = ['https://eztvx.to/api'];

let cachedDomains = null;

async function getDomains() {
    if (cachedDomains) return cachedDomains;

    try {
        const config = await getScraperConfig('eztv');
        if (config && config.links && Array.isArray(config.links) && config.links.length > 0) {
            cachedDomains = config.links;
            console.log(`[EZTV] Loaded ${cachedDomains.length} domains from DB`);
        } else {
            cachedDomains = EZTV_FALLBACK;
            console.log(`[EZTV] Using fallback domains`);
        }
    } catch (e) {
        console.error(`[EZTV] Failed to load config: ${e.message}`);
        cachedDomains = EZTV_FALLBACK;
    }

    return cachedDomains;
}

/**
 * Search EZTV for TV series by IMDB ID
 * @param {string} imdbId - IMDB ID (e.g., "tt0944947")
 * @param {number} season - Season number (optional)
 * @param {number} episode - Episode number (optional)
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchEZTV(imdbId, season, episode) {
    const domains = await getDomains();

    for (const domain of domains) {
        try {
            // EZTV expects numeric IMDB ID without 'tt' prefix
            const numericId = imdbId.replace('tt', '');

            const response = await axios.get(`${domain}/get-torrents`, {
                params: { imdb_id: numericId, limit: 100 },
                timeout: 5000
            });

            let torrents = response.data?.torrents || [];

            // Filter by season/episode if provided
            if (season !== undefined) {
                torrents = torrents.filter(t => t.season === season);
            }
            if (episode !== undefined) {
                torrents = torrents.filter(t => t.episode === episode);
            }

            const results = torrents.map(torrent => ({
                infoHash: torrent.hash?.toLowerCase(),
                provider: 'eztv',
                title: torrent.title || torrent.filename,
                size: torrent.size_bytes,
                type: 'series',
                uploadDate: new Date(torrent.date_released_unix * 1000),
                seeders: torrent.seeds,
                resolution: extractResolution(torrent.title),
                imdbId: imdbId,
                imdbSeason: torrent.season,
                imdbEpisode: torrent.episode,
                magnetUrl: torrent.magnet_url
            }));

            console.log(`EZTV: Found ${results.length} torrents for ${imdbId} S${season}E${episode}`);
            return results;
        } catch (error) {
            console.error(`EZTV search failed for ${imdbId}:`, error.message);
            // Continue to next domain
            continue;
        }
    }

    return [];
}

function extractResolution(title) {
    if (!title) return null;
    if (title.includes('2160p') || title.includes('4K')) return '4k';
    if (title.includes('1080p')) return '1080p';
    if (title.includes('720p')) return '720p';
    if (title.includes('480p')) return '480p';
    return null;
}

export default { searchEZTV };
