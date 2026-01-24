import axios from 'axios';
import * as cheerio from 'cheerio';

// Fallback domains for 1337x
// Updated 2026-01-24 - added more working mirrors
const T1337X_DOMAINS = [
    'https://1337x.to',
    'https://1337x.st',
    'https://www.1337xx.to',
    'https://x1337x.eu',
    'https://1337xto.to'
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
            'cf-ray': error.response.headers?.['cf-ray']
        };
        // Check for common block indicators
        if (typeof error.response.data === 'string') {
            const data = error.response.data.toLowerCase();
            if (data.includes('cloudflare') || data.includes('challenge')) {
                details.blocked = 'CLOUDFLARE_CHALLENGE';
            } else if (data.includes('access denied') || data.includes('forbidden')) {
                details.blocked = 'ACCESS_DENIED';
            }
            details.responsePreview = error.response.data.substring(0, 300);
        }
    } else if (error.request) {
        details.type = 'NO_RESPONSE';
        details.timeout = error.code === 'ECONNABORTED';
        details.connectionRefused = error.code === 'ECONNREFUSED';
        details.dnsError = error.code === 'ENOTFOUND';
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
                console.log(`1337x [${context}]: Attempt ${attempt}/${retries + 1} failed (${error.code || error.message}), retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Search 1337x for torrents by IMDB ID or title
 * @param {string} query - IMDB ID or search query
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function search1337x(query, type) {
    const errors = [];

    // Try each domain with retry logic
    for (const baseUrl of T1337X_DOMAINS) {
        const searchUrl = `${baseUrl}/search/${encodeURIComponent(query)}/1/`;
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
                console.warn(`1337x (${baseUrl}): Cloudflare challenge detected`);
                throw new Error('Cloudflare challenge blocking request');
            }

            const $ = cheerio.load(response.data);
            const torrents = [];
            const detailPromises = [];

            // Check if we got a valid search results page
            const tableRows = $('table.table-list tbody tr');
            console.log(`1337x (${baseUrl}): Found ${tableRows.length} table rows in search results`);

            if (tableRows.length === 0) {
                // Check if "No results" message is present
                const noResults = $('div.box-info-detail').text().toLowerCase().includes('no results');
                if (noResults) {
                    console.log(`1337x (${baseUrl}): Search returned no results for "${query}"`);
                    return [];
                }
                // Page structure might have changed
                console.warn(`1337x (${baseUrl}): No table rows found, page structure may have changed`);
            }

            // Get first 10 results
            tableRows.slice(0, 10).each((i, el) => {
                const nameEl = $(el).find('td.name a:nth-child(2)');
                const title = nameEl.text().trim();
                const detailUrl = baseUrl + nameEl.attr('href');
                const seeders = parseInt($(el).find('td.seeds').text()) || 0;
                const size = $(el).find('td.size').text().split('B')[0] + 'B';

                if (title && detailUrl) {
                    detailPromises.push(
                        getInfoHash(detailUrl, baseUrl).then(hash => ({
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
            let failedDetailFetches = 0;
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value?.infoHash) {
                    torrents.push(result.value);
                } else if (result.status === 'rejected') {
                    failedDetailFetches++;
                }
            }

            if (failedDetailFetches > 0) {
                console.log(`1337x (${baseUrl}): ${failedDetailFetches}/${detailPromises.length} detail page fetches failed`);
            }

            console.log(`1337x: Found ${torrents.length} torrents for ${query}`);
            return torrents;
        } catch (error) {
            const errorDetails = formatErrorDetails(error, searchUrl);
            errors.push({ domain: baseUrl, ...errorDetails });
            console.log(`1337x (${baseUrl}): Failed - ${error.code || 'ERROR'}: ${error.message}${error.response ? ` [HTTP ${error.response.status}]` : ''}`);
            continue;
        }
    }

    console.error(`1337x search failed for ${query}: All domains exhausted`);
    console.error(`1337x error details: ${JSON.stringify(errors, null, 2)}`);
    return [];
}

async function getInfoHash(detailUrl, baseUrl = '') {
    try {
        const response = await axios.get(detailUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 500
        });

        if (response.status !== 200) {
            console.log(`1337x: Detail page fetch failed [HTTP ${response.status}] for ${detailUrl}`);
            return null;
        }

        const $ = cheerio.load(response.data);
        const magnetLink = $('a[href^="magnet:"]').attr('href');

        if (magnetLink) {
            const match = magnetLink.match(/btih:([a-fA-F0-9]+)/i);
            return match ? match[1] : null;
        }

        // Magnet link not found - check for alternative selectors or page structure changes
        const allLinks = $('a').length;
        console.log(`1337x: No magnet link found on detail page (${allLinks} total links on page)`);
        return null;
    } catch (error) {
        console.log(`1337x: Detail page error - ${error.code || 'ERROR'}: ${error.message}`);
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
