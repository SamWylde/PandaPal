import * as cheerio from 'cheerio';
import { parseSize, extractResolution } from '../titleHelper.js';
import { performRequest } from '../requestHelper.js';

const SOLID_DOMAINS = [
    'https://solidtorrents.to'
];

export async function searchSolidTorrents(query) {
    const torrents = [];

    for (const domain of SOLID_DOMAINS) {
        try {
            const url = `${domain}/search?q=${encodeURIComponent(query)}`;
            // performRequest handles Cloudflare detection and browser fallback
            const response = await performRequest(url);

            const $ = cheerio.load(response.data);

            $('.search-result').each((i, el) => {
                const title = $(el).find('h5.title a').text().trim();
                const magnetUrl = $(el).find('a[href^="magnet:"]').attr('href');
                const infoHash = magnetUrl ? magnetUrl.match(/btih:([a-fA-F0-9]+)/i)?.[1] : null;

                const seeds = parseInt($(el).find('.stats .sees').text()) || 0;
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
