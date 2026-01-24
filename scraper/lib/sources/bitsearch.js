import * as cheerio from 'cheerio';
import { parseSize, extractResolution } from '../titleHelper.js';
import { performRequest } from '../requestHelper.js';

const BITSEARCH_DOMAINS = [
    'https://bitsearch.to'
];

export async function searchBitSearch(query) {
    const torrents = [];
    const errors = [];

    for (const domain of BITSEARCH_DOMAINS) {
        try {
            const url = `${domain}/search?q=${encodeURIComponent(query)}`;
            // performRequest handles Cloudflare detection and browser fallback
            const response = await performRequest(url);

            const $ = cheerio.load(response.data);

            $('li.search-result').each((i, el) => {
                const title = $(el).find('h5.title a').text().trim();
                const magnetUrl = $(el).find('a.dl-magnet').attr('href');
                const infoHash = magnetUrl ? magnetUrl.match(/btih:([a-fA-F0-9]+)/i)?.[1] : null;

                const stats = $(el).find('div.stats');
                const seeds = parseInt(stats.find('div.seeds').text()) || 0;
                const size = stats.find('div.size').text().trim();

                if (title && infoHash) {
                    torrents.push({
                        title,
                        infoHash: infoHash.toLowerCase(),
                        magnetUrl,
                        seeders: seeds,
                        size: parseSize(size),
                        uploadDate: new Date(),
                        provider: 'BitSearch',
                        resolution: extractResolution(title),
                        type: 'other'
                    });
                }
            });

            console.log(`[BitSearch] Found ${torrents.length} torrents for query: ${query}`);
            return torrents;

        } catch (error) {
            console.error(`[BitSearch] Error searching ${domain}: ${error.message}`);
            errors.push(error);
        }
    }
    return torrents;
}

export default { searchBitSearch };
