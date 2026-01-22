import axios from 'axios';
import * as cheerio from 'cheerio';

const TG_BASE = 'https://torrentgalaxy.to';

/**
 * Search TorrentGalaxy for torrents by IMDB ID or title
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchTorrentGalaxy(imdbId, type) {
    try {
        const searchUrl = `${TG_BASE}/torrents.php?search=${encodeURIComponent(imdbId)}`;

        const response = await axios.get(searchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const torrents = [];

        $('div.tgxtablerow').slice(0, 15).each((i, el) => {
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
        console.error(`TorrentGalaxy search failed for ${imdbId}:`, error.message);
        return [];
    }
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
