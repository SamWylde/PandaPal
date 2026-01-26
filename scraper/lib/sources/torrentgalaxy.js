import * as cheerio from 'cheerio';
import { performRequest } from '../requestHelper.js';
import { getScraperConfig } from '../db.js';

// Fallback domains for TorrentGalaxy
const TG_FALLBACK = [
    'https://tgx.rs',
    'https://torrentgalaxy.one',
    'https://torrentgalaxy.to',
    'https://torrentgalaxy.mx'
];

let cachedDomains = null;

async function getDomains() {
    if (cachedDomains) return cachedDomains;

    try {
        const config = await getScraperConfig('torrentgalaxy');
        if (config && config.links && Array.isArray(config.links) && config.links.length > 0) {
            cachedDomains = config.links;
            console.log(`[TorrentGalaxy] Loaded ${cachedDomains.length} domains from DB`);
        } else {
            cachedDomains = TG_FALLBACK;
            console.log(`[TorrentGalaxy] Using fallback domains`);
        }
    } catch (e) {
        console.error(`[TorrentGalaxy] Failed to load config: ${e.message}`);
        cachedDomains = TG_FALLBACK;
    }

    return cachedDomains;
}

/**
 * Search TorrentGalaxy for torrents by IMDB ID or title
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchTorrentGalaxy(imdbId, type) {
    const errors = [];
    const domains = await getDomains();

    // FAST MODE: Only try first 2 domains
    const domainsToTry = domains.slice(0, 2);

    // Try each domain
    for (const baseUrl of domainsToTry) {
        const searchUrl = `${baseUrl}/torrents.php?search=${encodeURIComponent(imdbId)}`;
        try {
            // FAST MODE: Skip FlareSolverr (45s timeout) - fail fast if blocked
            const response = await performRequest(searchUrl, {
                skipBrowserFallback: true,
                timeout: 5000
            });

            const $ = cheerio.load(response.data);
            const torrents = [];

            // Check for valid page structure
            const tableRows = $('div.tgxtablerow');
            console.log(`TorrentGalaxy (${baseUrl}): Found ${tableRows.length} table rows in search results`);

            if (tableRows.length === 0) {
                return [];
            }

            tableRows.slice(0, 15).each((i, el) => {
                const titleEl = $(el).find('a.txlight');
                const title = titleEl.text().trim();

                // Get magnet link directly from the page
                const magnetEl = $(el).find('a[href^="magnet:"]');
                const magnetUrl = magnetEl.attr('href');

                const seeders = parseInt($(el).find('span[title="Seeders/Leechers"] b').first().text()) || 0;
                const sizeEl = $(el).find('span.badge-secondary').first();
                const size = sizeEl.text().trim();

                if (title && magnetUrl) {
                    const hashMatch = magnetUrl.match(/btih:([a-fA-F0-9]+)/i);
                    if (hashMatch) {
                        torrents.push({
                            infoHash: hashMatch[1].toLowerCase(),
                            provider: 'torrentgalaxy',
                            title: title,
                            size: parseSize(size),
                            type: type,
                            uploadDate: new Date(),
                            seeders: seeders,
                            resolution: extractResolution(title),
                            imdbId: imdbId,
                            magnetUrl: magnetUrl
                        });
                    }
                }
            });

            console.log(`TorrentGalaxy: Found ${torrents.length} torrents for ${imdbId}`);
            return torrents;
        } catch (error) {
            console.error(`TorrentGalaxy (${baseUrl}) failed: ${error.message}`);
            errors.push(error);
            continue;
        }
    }

    return [];
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    if (unit === 'TB') return Math.floor(value * 1024 * 1024 * 1024 * 1024);
    if (unit === 'GB') return Math.floor(value * 1024 * 1024 * 1024);
    if (unit === 'MB') return Math.floor(value * 1024 * 1024);
    if (unit === 'KB') return Math.floor(value * 1024);
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

export default { searchTorrentGalaxy };

