import * as cheerio from 'cheerio';
import { performRequest } from '../requestHelper.js';

// Fallback domains for 1337x
const T1337X_DOMAINS = [
    'https://1337x.to',
    'https://1337x.st',
    'https://www.1337xx.to',
    'https://x1337x.eu',
    'https://1337xto.to'
];

/**
 * Search 1337x for torrents by IMDB ID or title
 * @param {string} query - IMDB ID or search query
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function search1337x(query, type) {
    const errors = [];

    // Try each domain 
    for (const baseUrl of T1337X_DOMAINS) {
        const searchUrl = `${baseUrl}/search/${encodeURIComponent(query)}/1/`;
        try {
            // performRequest handles Cloudflare detection and browser fallback
            const response = await performRequest(searchUrl);

            // Access response.data (which might be from axios or the browser html string)
            const $ = cheerio.load(response.data);
            const torrents = [];

            // Check if we got a valid search results page
            const tableRows = $('table.table-list tbody tr');
            console.log(`1337x (${baseUrl}): Found ${tableRows.length} table rows in search results`);

            if (tableRows.length === 0) {
                // If we used the browser and still got 0 rows, it might just be 0 results
                return [];
            }

            // Get first 10 results
            // We use a map to handle the async getInfoHash calls properly
            const promises = [];

            tableRows.slice(0, 10).each((i, el) => {
                const nameEl = $(el).find('td.name a:nth-child(2)');
                const title = nameEl.text().trim();
                const detailUrl = baseUrl + nameEl.attr('href');
                const seeders = parseInt($(el).find('td.seeds').text()) || 0;
                const size = $(el).find('td.size').text().split('B')[0] + 'B';

                if (title && detailUrl) {
                    promises.push(
                        getInfoHash(detailUrl).then(hash => {
                            if (!hash) return null;
                            return {
                                infoHash: hash.toLowerCase(),
                                provider: '1337x',
                                title: title,
                                size: parseSize(size),
                                type: type,
                                uploadDate: new Date(),
                                seeders: seeders,
                                resolution: extractResolution(title),
                                magnetUrl: `magnet:?xt=urn:btih:${hash}`
                            };
                        })
                    );
                }
            });

            const results = await Promise.allSettled(promises);
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    torrents.push(result.value);
                }
            }

            console.log(`1337x: Found ${torrents.length} torrents for ${query}`);
            return torrents;

        } catch (error) {
            console.error(`1337x (${baseUrl}) failed: ${error.message}`);
            errors.push(error);
            continue;
        }
    }
    return [];
}

async function getInfoHash(detailUrl) {
    try {
        // Also use performRequest here as detail pages are also protected
        const response = await performRequest(detailUrl);
        const $ = cheerio.load(response.data);
        const magnetLink = $('a[href^="magnet:"]').attr('href');

        if (magnetLink) {
            const match = magnetLink.match(/btih:([a-fA-F0-9]+)/i);
            return match ? match[1] : null;
        }
        return null;
    } catch (e) {
        console.error(`1337x details failed for ${detailUrl}: ${e.message}`);
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
