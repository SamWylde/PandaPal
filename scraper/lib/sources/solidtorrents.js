import * as cheerio from 'cheerio';
import { parseSize, extractResolution } from '../titleHelper.js';
import { performRequest } from '../requestHelper.js';
import { getScraperConfig } from '../db.js';

const SOLID_FALLBACK = ['https://solidtorrents.to'];

let cachedDomains = null;

async function getDomains() {
    if (cachedDomains) return cachedDomains;

    try {
        const config = await getScraperConfig('solidtorrents');
        if (config && config.links && Array.isArray(config.links) && config.links.length > 0) {
            cachedDomains = config.links;
            console.log(`[SolidTorrents] Loaded ${cachedDomains.length} domains from DB`);
        } else {
            cachedDomains = SOLID_FALLBACK;
            console.log(`[SolidTorrents] Using fallback domains`);
        }
    } catch (e) {
        console.error(`[SolidTorrents] Failed to load config: ${e.message}`);
        cachedDomains = SOLID_FALLBACK;
    }

    return cachedDomains;
}

export async function searchSolidTorrents(query, skipBrowser = false) {
    const torrents = [];
    const domains = await getDomains();

    for (const domain of domains) {
        try {
            const url = `${domain}/search?q=${encodeURIComponent(query)}`;
            // FAST MODE: Skip browser fallback and use short timeout
            const response = await performRequest(url, {
                skipBrowserFallback: skipBrowser,
                timeout: 5000,
                maxRedirects: 3
            });

            const $ = cheerio.load(response.data);

            $('.search-result').each((i, el) => {
                const title = $(el).find('h5.title a').text().trim();
                const magnetUrl = $(el).find('a[href^="magnet:"]').attr('href');
                const infoHash = magnetUrl ? magnetUrl.match(/btih:([a-fA-F0-9]+)/i)?.[1] : null;

                const seeds = parseInt($(el).find('.stats .seeds').text()) || 0;
                const size = $(el).find('.stats .size').text().trim();

                if (title && infoHash) {
                    torrents.push({
                        title,
                        infoHash: infoHash.toLowerCase(),
                        magnetUrl,
                        seeders: seeds,
                        size: parseSize(size),
                        uploadDate: new Date(),
                        provider: 'SolidTorrents',
                        resolution: extractResolution(title),
                        type: 'other'
                    });
                }
            });

            console.log(`[SolidTorrents] Found ${torrents.length} torrents for query: ${query}`);
            return torrents;
        } catch (error) {
            console.error(`[SolidTorrents] Error searching ${domain}: ${error.message}`);
        }
    }

    return torrents;
}

export default { searchSolidTorrents };
