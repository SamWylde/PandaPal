import axios from 'axios';
import * as cheerio from 'cheerio';

const T1337X_BASE = 'https://1337x.to';

/**
 * Search 1337x for torrents by IMDB ID or title
 * @param {string} query - IMDB ID or search query
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function search1337x(query, type) {
    try {
        const searchUrl = `${T1337X_BASE}/search/${encodeURIComponent(query)}/1/`;

        const response = await axios.get(searchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const torrents = [];
        const detailPromises = [];

        // Get first 10 results
        $('table.table-list tbody tr').slice(0, 10).each((i, el) => {
            const nameEl = $(el).find('td.name a:nth-child(2)');
            const title = nameEl.text().trim();
            const detailUrl = T1337X_BASE + nameEl.attr('href');
            const seeders = parseInt($(el).find('td.seeds').text()) || 0;
            const size = $(el).find('td.size').text().split('B')[0] + 'B';

            if (title && detailUrl) {
                detailPromises.push(
                    getInfoHash(detailUrl).then(hash => ({
                        infoHash: hash?.toLowerCase(),
                        provider: '1337x',
                        title: title,
                        size: parseSize(size),
                        type: type,
                        uploadDate: new Date(),
                        seeders: seeders,
                        resolution: extractResolution(title),
                        magnetUrl: hash ? `magnet:?xt=urn:btih:${hash}` : null
                    }))
                );
            }
        });

        const results = await Promise.allSettled(detailPromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value?.infoHash) {
                torrents.push(result.value);
            }
        }

        console.log(`1337x: Found ${torrents.length} torrents for ${query}`);
        return torrents;
    } catch (error) {
        console.error(`1337x search failed for ${query}:`, error.message);
        return [];
    }
}

async function getInfoHash(detailUrl) {
    try {
        const response = await axios.get(detailUrl, {
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const magnetLink = $('a[href^="magnet:"]').attr('href');

        if (magnetLink) {
            const match = magnetLink.match(/btih:([a-fA-F0-9]+)/i);
            return match ? match[1] : null;
        }
        return null;
    } catch {
        return null;
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

export default { search1337x };
