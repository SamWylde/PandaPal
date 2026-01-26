/**
 * Bulk Indexer Diagnostic Endpoint
 *
 * Tests ALL active NON-CLOUDFLARE indexers with a standardized query.
 * Usage: GET /api/test-all-indexers?query=One+Fast+Move&type=movie
 *
 * Only tests indexers that DON'T require Cloudflare bypass (CF-free).
 *
 * Returns a comprehensive report showing:
 * - Which indexers are working
 * - Which are failing
 * - Which are returning garbage (0 relevant results)
 * - Sample results from each
 */

import { supabase } from '../scraper/lib/db.js';
import { searchWithCardigann } from '../scraper/lib/cardigann/search.js';
import { searchYTS } from '../scraper/lib/sources/yts.js';
import { search1337x } from '../scraper/lib/sources/t1337x.js';
import { searchTorrentGalaxy } from '../scraper/lib/sources/torrentgalaxy.js';
import { searchBitSearch } from '../scraper/lib/sources/bitsearch.js';
import { searchSolidTorrents } from '../scraper/lib/sources/solidtorrents.js';
import { filterByRelevance } from '../scraper/lib/realtime.js';

// Legacy scraper mapping
const LEGACY_SCRAPERS = {
    'yts': { fn: searchYTS, useImdb: true },
    '1337x': { fn: search1337x, useImdb: true },
    'torrentgalaxyclone': { fn: searchTorrentGalaxy, useImdb: true },
    'bitsearch': { fn: searchBitSearch, useImdb: false },
    'solidtorrents': { fn: searchSolidTorrents, useImdb: false },
};

// Known CF-protected indexers (based on common knowledge)
const KNOWN_CF_INDEXERS = new Set([
    '1337x', 'torrentgalaxyclone', 'bitsearch', 'solidtorrents',
    'nyaasi', 'thepiratebay', 'limetorrents', 'kickasstorrents',
    'rarbg', 'magnetdl', 'torrentleech'
]);

// Test timeout per indexer (10 seconds)
const INDEXER_TIMEOUT = 10000;

async function testIndexer(indexerId, query, type, imdbId) {
    const startTime = Date.now();
    const result = {
        indexer: indexerId,
        status: 'unknown',
        resultCount: 0,
        relevantCount: 0,
        sampleTitles: [],
        duration: 0,
        error: null,
        searchMethod: null
    };

    try {
        let results = [];

        // Wrap in timeout
        const searchPromise = (async () => {
            // Check if it's a legacy scraper
            if (LEGACY_SCRAPERS[indexerId]) {
                result.searchMethod = 'legacy';
                const scraper = LEGACY_SCRAPERS[indexerId];

                if (scraper.useImdb && imdbId) {
                    if (indexerId === 'yts') {
                        return await scraper.fn(imdbId);
                    } else {
                        return await scraper.fn(imdbId, type);
                    }
                } else {
                    return await scraper.fn(query, true);
                }
            } else {
                // Use Cardigann engine
                result.searchMethod = 'cardigann';
                return await searchWithCardigann(indexerId, query, {
                    imdbId,
                    type
                });
            }
        })();

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), INDEXER_TIMEOUT)
        );

        results = await Promise.race([searchPromise, timeoutPromise]);

        result.resultCount = results.length;

        // Check relevance
        const relevant = filterByRelevance(results, query, imdbId);
        result.relevantCount = relevant.length;

        // Get sample titles
        result.sampleTitles = results.slice(0, 5).map(r => r.title || r.name || 'Unknown');

        // Determine status
        if (results.length === 0) {
            result.status = 'empty';
        } else if (relevant.length === 0) {
            result.status = 'garbage'; // Results found but none relevant
        } else if (relevant.length < results.length * 0.3) {
            result.status = 'mostly_garbage'; // Less than 30% relevant
        } else {
            result.status = 'working';
        }

    } catch (error) {
        result.status = 'error';
        result.error = error.message;
    }

    result.duration = Date.now() - startTime;
    return result;
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const {
        query = 'One Fast Move',
        type = 'movie',
        imdbId = 'tt21096576',
        limit = 50 // Max indexers to test
    } = req.query;

    console.log(`[TestAllIndexers] Starting bulk test with query="${query}" type=${type} (CF-free only)`);
    const startTime = Date.now();

    // Get all indexers from database with their last_error to detect CF status
    let indexers = [];
    let cfBlockedIndexers = [];

    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('indexer_health')
                .select('id, priority, success_rate, working_domain, last_error, content_types')
                .eq('is_public', true)
                .gte('success_rate', 10)  // At least 10% success rate
                .order('priority', { ascending: false })
                .limit(parseInt(limit) * 2);

            if (!error && data) {
                // Separate CF-blocked vs CF-free indexers
                for (const row of data) {
                    const lastError = (row.last_error || '').toLowerCase();
                    const isCFBlocked = lastError.includes('cloudflare') ||
                                        lastError.includes('cf challenge') ||
                                        lastError.includes('ddos') ||
                                        KNOWN_CF_INDEXERS.has(row.id);

                    if (isCFBlocked) {
                        cfBlockedIndexers.push({ id: row.id, error: row.last_error });
                    } else {
                        indexers.push({
                            id: row.id,
                            priority: row.priority,
                            workingDomain: row.working_domain,
                            contentTypes: row.content_types
                        });
                    }
                }
            }
        }
        console.log(`[TestAllIndexers] Found ${indexers.length} CF-free indexers, ${cfBlockedIndexers.length} CF-blocked (skipped)`);
    } catch (e) {
        console.error(`[TestAllIndexers] Failed to get indexers: ${e.message}`);
    }

    // Filter by content type compatibility
    const movieIncompatible = ['eztv', 'showrss', 'nyaasi', 'dmhy', 'acgrip', 'bangumi-moe', 'xxxclub', 'catorrent', 'ehentai', 'skidrowrepack'];
    const seriesIncompatible = ['yts'];

    const filteredIndexers = indexers.filter(idx => {
        if (type === 'movie' && movieIncompatible.includes(idx.id)) return false;
        if (type === 'series' && seriesIncompatible.includes(idx.id)) return false;
        return true;
    });

    console.log(`[TestAllIndexers] Testing ${filteredIndexers.length} compatible CF-free indexers`);

    // Test all indexers in parallel (with concurrency limit)
    const CONCURRENCY = 10;
    const results = [];

    for (let i = 0; i < filteredIndexers.length; i += CONCURRENCY) {
        const batch = filteredIndexers.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(idx => testIndexer(idx.id, query, type, imdbId))
        );
        results.push(...batchResults);
    }

    // Categorize results
    const summary = {
        working: results.filter(r => r.status === 'working'),
        empty: results.filter(r => r.status === 'empty'),
        garbage: results.filter(r => r.status === 'garbage'),
        mostlyGarbage: results.filter(r => r.status === 'mostly_garbage'),
        errors: results.filter(r => r.status === 'error'),
    };

    const report = {
        testQuery: query,
        testType: type,
        testImdbId: imdbId,
        timestamp: new Date().toISOString(),
        totalDuration: Date.now() - startTime,
        totalIndexersTested: results.length,
        cfBlockedSkipped: cfBlockedIndexers.length,
        summary: {
            working: summary.working.length,
            empty: summary.empty.length,
            garbage: summary.garbage.length,
            mostlyGarbage: summary.mostlyGarbage.length,
            errors: summary.errors.length,
            cfBlocked: cfBlockedIndexers.length,
        },
        categories: {
            working: summary.working.map(r => ({
                id: r.indexer,
                results: r.resultCount,
                relevant: r.relevantCount,
                duration: r.duration,
                sample: r.sampleTitles.slice(0, 2)
            })),
            garbage: summary.garbage.map(r => ({
                id: r.indexer,
                results: r.resultCount,
                relevant: r.relevantCount,
                duration: r.duration,
                sample: r.sampleTitles.slice(0, 3),
                note: 'Returns results but NONE match the query!'
            })),
            mostlyGarbage: summary.mostlyGarbage.map(r => ({
                id: r.indexer,
                results: r.resultCount,
                relevant: r.relevantCount,
                duration: r.duration,
                sample: r.sampleTitles.slice(0, 3),
                note: 'Most results are irrelevant'
            })),
            empty: summary.empty.map(r => ({
                id: r.indexer,
                duration: r.duration,
                note: 'No results returned'
            })),
            errors: summary.errors.map(r => ({
                id: r.indexer,
                error: r.error,
                duration: r.duration
            })),
            cfBlocked: cfBlockedIndexers.map(r => ({
                id: r.id,
                note: 'Requires Cloudflare bypass (not tested)'
            }))
        }
    };

    console.log(`[TestAllIndexers] Complete: ${summary.working.length} working, ${summary.garbage.length} garbage, ${summary.errors.length} errors, ${cfBlockedIndexers.length} CF-blocked (skipped)`);

    return res.status(200).json(report);
}
