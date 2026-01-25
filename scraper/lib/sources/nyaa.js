import axios from 'axios';
import { getScraperConfig } from '../db.js';

const NYAA_FALLBACK = ['https://nyaa.si'];

let cachedDomains = null;

async function getDomains() {
    if (cachedDomains) return cachedDomains;

    try {
        const config = await getScraperConfig('nyaasi');
        if (config && config.links && Array.isArray(config.links) && config.links.length > 0) {
            cachedDomains = config.links;
            console.log(`[Nyaa] Loaded ${cachedDomains.length} domains from DB`);
        } else {
            cachedDomains = NYAA_FALLBACK;
            console.log(`[Nyaa] Using fallback domains`);
        }
    } catch (e) {
        console.error(`[Nyaa] Failed to load config: ${e.message}`);
        cachedDomains = NYAA_FALLBACK;
    }

    return cachedDomains;
}

/**
 * Search Nyaa for anime by Kitsu ID or title
 * @param {string} kitsuId - Kitsu ID
 * @param {string} title - Anime title (fallback)
 * @param {number} episode - Episode number (optional)
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchNyaa(kitsuId, title, episode) {
    const domains = await getDomains();

    for (const domain of domains) {
        try {
            // Nyaa doesn't have a proper API, but we can use RSS/search
            // Search by title since Nyaa doesn't support Kitsu IDs directly
            const searchQuery = episode ? `${title} ${episode}` : title;

            const response = await axios.get(`${domain}/?page=rss&q=${encodeURIComponent(searchQuery)}&c=1_2&f=0`, {
                timeout: 5000
            });

            // Parse RSS XML response
            const torrents = parseNyaaRSS(response.data, kitsuId, episode);

            console.log(`Nyaa: Found ${torrents.length} torrents for ${title}`);
            return torrents;
        } catch (error) {
            console.error(`Nyaa (${domain}) search failed for ${title}:`, error.message);
            // Continue to next domain
        }
    }
    return [];
}

function parseNyaaRSS(xml, kitsuId, episode) {
    const torrents = [];

    // Simple regex-based XML parsing for RSS items
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
    const linkRegex = /<link>(.*?)<\/link>/;
    const seedersRegex = /<nyaa:seeders>(\d+)<\/nyaa:seeders>/;
    const sizeRegex = /<nyaa:size>(.*?)<\/nyaa:size>/;
    const infoHashRegex = /<nyaa:infoHash>([a-fA-F0-9]+)<\/nyaa:infoHash>/;

    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];

        const titleMatch = item.match(titleRegex);
        const linkMatch = item.match(linkRegex);
        const seedersMatch = item.match(seedersRegex);
        const sizeMatch = item.match(sizeRegex);
        const hashMatch = item.match(infoHashRegex);

        if (titleMatch && hashMatch) {
            torrents.push({
                infoHash: hashMatch[1].toLowerCase(),
                provider: 'nyaasi',
                title: titleMatch[1],
                size: parseNyaaSize(sizeMatch?.[1]),
                type: 'anime',
                uploadDate: new Date(),
                seeders: parseInt(seedersMatch?.[1] || '0'),
                resolution: extractResolution(titleMatch[1]),
                kitsuId: parseInt(kitsuId),
                kitsuEpisode: episode,
                magnetUrl: `magnet:?xt=urn:btih:${hashMatch[1]}`
            });
        }
    }

    return torrents.slice(0, 50); // Limit results
}

function parseNyaaSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GiB|MiB|KiB)/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    if (unit === 'gib') return Math.floor(value * 1024 * 1024 * 1024);
    if (unit === 'mib') return Math.floor(value * 1024 * 1024);
    if (unit === 'kib') return Math.floor(value * 1024);
    return 0;
}

function extractResolution(title) {
    if (!title) return null;
    if (title.includes('2160p') || title.includes('4K')) return '4k';
    if (title.includes('1080p')) return '1080p';
    if (title.includes('720p')) return '720p';
    if (title.includes('480p')) return '480p';
    return null;
}

export default { searchNyaa };
