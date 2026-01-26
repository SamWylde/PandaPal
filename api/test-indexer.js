/**
 * Indexer Diagnostic Endpoint
 *
 * Tests a specific indexer with a given query to verify it's working correctly.
 * Usage: GET /api/test-indexer?indexer=yts&query=One+Fast+Move&type=movie
 *
 * Returns detailed info about the search including:
 * - URL being fetched
 * - Query parameters
 * - Number of results
 * - Sample result titles
 */

import { searchWithCardigann } from '../scraper/lib/cardigann/search.js';
import { searchYTS } from '../scraper/lib/sources/yts.js';
import { search1337x } from '../scraper/lib/sources/t1337x.js';
import { searchTorrentGalaxy } from '../scraper/lib/sources/torrentgalaxy.js';

// Legacy scraper mapping
const LEGACY_SCRAPERS = {
    'yts': searchYTS,
    '1337x': search1337x,
    'torrentgalaxyclone': searchTorrentGalaxy,
};

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const { indexer, query, type = 'movie', imdbId } = req.query;

    if (!indexer) {
        return res.status(400).json({
            error: 'Missing required parameter: indexer',
            usage: '/api/test-indexer?indexer=yts&query=One+Fast+Move&type=movie'
        });
    }

    if (!query && !imdbId) {
        return res.status(400).json({
            error: 'Missing required parameter: query or imdbId',
            usage: '/api/test-indexer?indexer=yts&query=One+Fast+Move&type=movie'
        });
    }

    const startTime = Date.now();
    const diagnostic = {
        indexer,
        query: query || imdbId,
        type,
        timestamp: new Date().toISOString(),
        searchMethod: null,
        results: [],
        resultCount: 0,
        sampleTitles: [],
        duration: 0,
        error: null
    };

    try {
        let results = [];

        // Check if it's a legacy scraper
        if (LEGACY_SCRAPERS[indexer]) {
            diagnostic.searchMethod = 'legacy';
            console.log(`[TestIndexer] Using legacy scraper for ${indexer}`);

            if (indexer === 'yts') {
                results = await LEGACY_SCRAPERS[indexer](imdbId || query);
            } else {
                results = await LEGACY_SCRAPERS[indexer](imdbId || query, type);
            }
        } else {
            // Use Cardigann engine
            diagnostic.searchMethod = 'cardigann';
            console.log(`[TestIndexer] Using Cardigann engine for ${indexer}`);

            results = await searchWithCardigann(indexer, query || imdbId, {
                imdbId,
                type
            });
        }

        diagnostic.results = results;
        diagnostic.resultCount = results.length;
        diagnostic.sampleTitles = results.slice(0, 10).map(r => ({
            title: r.title || r.name,
            size: r.size,
            seeders: r.seeders,
            provider: r.provider || indexer
        }));
        diagnostic.duration = Date.now() - startTime;

        console.log(`[TestIndexer] ${indexer} returned ${results.length} results in ${diagnostic.duration}ms`);

    } catch (error) {
        diagnostic.error = {
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 5)
        };
        diagnostic.duration = Date.now() - startTime;
        console.error(`[TestIndexer] ${indexer} failed: ${error.message}`);
    }

    // Don't include full results in response to keep it readable
    const response = {
        ...diagnostic,
        results: undefined, // Remove full results array
        summary: diagnostic.error
            ? `FAILED: ${diagnostic.error.message}`
            : `SUCCESS: ${diagnostic.resultCount} results in ${diagnostic.duration}ms`
    };

    return res.status(diagnostic.error ? 500 : 200).json(response);
}
