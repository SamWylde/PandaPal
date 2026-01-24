import axios from 'axios';
import * as cheerio from 'cheerio';

// Fallback domains for TorrentGalaxy
// Updated 2026-01-24 - torrentgalaxy.to has been DOWN for weeks
// Reordered to prioritize working domains
const TG_DOMAINS = [
    'https://tgx.rs',
    'https://torrentgalaxy.one',
    'https://torrentgalaxy.to',        // Often down, keep as fallback
    'https://torrentgalaxy.mx'
];

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
            'cf-ray': error.response.headers?.['cf-ray'],
            'server': error.response.headers?.['server']
        };
        // Check for common block indicators
        if (typeof error.response.data === 'string') {
            const data = error.response.data.toLowerCase();
            if (data.includes('cloudflare') || data.includes('challenge')) {
                details.blocked = 'CLOUDFLARE_CHALLENGE';
            } else if (data.includes('access denied') || data.includes('forbidden')) {
                details.blocked = 'ACCESS_DENIED';
            } else if (data.includes('maintenance') || data.includes('temporarily')) {
                details.blocked = 'MAINTENANCE';
            }
            details.responsePreview = error.response.data.substring(0, 300);
        }
    } else if (error.request) {
        details.type = 'NO_RESPONSE';
        details.timeout = error.code === 'ECONNABORTED';
        details.connectionRefused = error.code === 'ECONNREFUSED';
        details.dnsError = error.code === 'ENOTFOUND';
        details.connectionReset = error.code === 'ECONNRESET';
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
                console.log(`TorrentGalaxy [${context}]: Attempt ${attempt}/${retries + 1} failed (${error.code || error.message}), retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Search TorrentGalaxy for torrents by IMDB ID or title
 * @param {string} imdbId - IMDB ID (e.g., "tt1375666")
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function searchTorrentGalaxy(imdbId, type) {
    const errors = [];

    // Try each domain with retry logic
    for (const baseUrl of TG_DOMAINS) {
        const searchUrl = `${baseUrl}/torrents.php?search=${encodeURIComponent(imdbId)}`;
        try {
            const response = await retryWithBackoff(
                () => axios.get(searchUrl, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    maxRedirects: 5,
                    validateStatus: (status) => status >= 200 && status < 500
                }),
                2,
                1000,
                baseUrl
            );

            // Check if response was successful
            if (response.status !== 200) {
                const error = new Error(`HTTP ${response.status}`);
                error.response = response;
                throw error;
            }

            if (!response.data) {
                throw new Error('Empty response body');
            }

            // Check for Cloudflare or other blocking
            const responseText = typeof response.data === 'string' ? response.data.toLowerCase() : '';
            if (responseText.includes('cloudflare') && responseText.includes('challenge')) {
                console.warn(`TorrentGalaxy (${baseUrl}): Cloudflare challenge detected`);
                throw new Error('Cloudflare challenge blocking request');
            }

            if (responseText.includes('maintenance') || responseText.includes('temporarily unavailable')) {
                console.warn(`TorrentGalaxy (${baseUrl}): Site appears to be in maintenance mode`);
                throw new Error('Site in maintenance mode');
            }

            const $ = cheerio.load(response.data);
            const torrents = [];

            // Check for valid page structure
            const tableRows = $('div.tgxtablerow');
            console.log(`TorrentGalaxy (${baseUrl}): Found ${tableRows.length} table rows in search results`);

            if (tableRows.length === 0) {
                // Check for "No torrents found" or similar messages
                const pageText = $.text().toLowerCase();
                if (pageText.includes('no torrents') || pageText.includes('no results')) {
                    console.log(`TorrentGalaxy (${baseUrl}): Search returned no results for "${imdbId}"`);
                    return [];
                }
                // Page structure might have changed
                console.warn(`TorrentGalaxy (${baseUrl}): No table rows found, page structure may have changed`);
                console.warn(`TorrentGalaxy (${baseUrl}): Page title: ${$('title').text()}`);
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
                } else if (title && !magnetUrl) {
                    console.log(`TorrentGalaxy: Row has title "${title.substring(0, 50)}..." but no magnet link`);
                }
            });

            console.log(`TorrentGalaxy: Found ${torrents.length} torrents for ${imdbId}`);
            return torrents;
        } catch (error) {
            const errorDetails = formatErrorDetails(error, searchUrl);
            errors.push({ domain: baseUrl, ...errorDetails });
            console.log(`TorrentGalaxy (${baseUrl}): Failed - ${error.code || 'ERROR'}: ${error.message}${error.response ? ` [HTTP ${error.response.status}]` : ''}`);
            continue;
        }
    }

    console.error(`TorrentGalaxy search failed for ${imdbId}: All domains exhausted`);
    console.error(`TorrentGalaxy error details: ${JSON.stringify(errors, null, 2)}`);
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
