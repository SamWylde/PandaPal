/**
 * Indexer Health Check Service
 *
 * Tests all PUBLIC indexers and records their performance metrics.
 * Results are stored in Supabase for prioritizing fast/reliable indexers.
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { getScraperConfig } from './db.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// Test query - a known popular movie (Inception)
const TEST_IMDB_ID = 'tt1375666';
const TEST_TITLE = 'Inception';

// Public indexers only - NO private/login-required indexers
// IDs must match Prowlarr indexer IDs (used for DB lookup)
const PUBLIC_INDEXERS = {
    'yts': {
        testUrl: (domain) => `${domain}/list_movies.json?query_term=${TEST_IMDB_ID}`,
        validateResponse: (data) => data?.status === 'ok',
        type: 'api'
    },
    'eztv': {
        testUrl: (domain) => `${domain}/get-torrents?imdb_id=1375666&limit=1`,
        validateResponse: (data) => data?.torrents !== undefined,
        type: 'api'
    },
    '1337x': {
        testUrl: (domain) => `${domain}/search/${TEST_TITLE}/1/`,
        validateResponse: (html) => html?.includes('table') || html?.includes('torrent'),
        type: 'html'
    },
    'torrentgalaxyclone': {  // Prowlarr name for TorrentGalaxy
        testUrl: (domain) => `${domain}/torrents.php?search=${TEST_IMDB_ID}`,
        validateResponse: (html) => html?.includes('tgxtablerow') || html?.includes('torrent'),
        type: 'html'
    },
    'nyaasi': {
        testUrl: (domain) => `${domain}/?page=rss&q=test`,
        validateResponse: (xml) => xml?.includes('<rss') || xml?.includes('<item>'),
        type: 'rss'
    },
    'bitsearch': {
        testUrl: (domain) => `${domain}/search?q=${TEST_TITLE}`,
        validateResponse: (html) => html?.includes('search-result') || html?.includes('torrent'),
        type: 'html'
    },
    'thepiratebay': {
        testUrl: (domain) => `${domain}/search/${TEST_TITLE}/1/99/0`,
        validateResponse: (html) => html?.includes('detName') || html?.includes('torrent'),
        type: 'html'
    },
    'limetorrents': {
        testUrl: (domain) => `${domain}/search/all/${TEST_TITLE}/`,
        validateResponse: (html) => html?.includes('torrent') || html?.includes('magnet'),
        type: 'html'
    },
    'torrentdownloads': {
        testUrl: (domain) => `${domain}/search/?search=${TEST_TITLE}`,
        validateResponse: (html) => html?.includes('torrent') || html?.includes('magnet'),
        type: 'html'
    }
};

/**
 * Run health check for a single indexer
 */
async function checkIndexer(indexerId) {
    const config = PUBLIC_INDEXERS[indexerId];
    if (!config) {
        return { success: false, error: 'Unknown indexer', responseTime: 0 };
    }

    // Get domains from database or use fallback
    const scraperConfig = await getScraperConfig(indexerId);
    const domains = scraperConfig?.links || [];

    if (domains.length === 0) {
        return { success: false, error: 'No domains configured', responseTime: 0 };
    }

    // Try each domain until one works
    for (const domain of domains) {
        const startTime = Date.now();
        try {
            const testUrl = config.testUrl(domain);
            console.log(`[HealthCheck] Testing ${indexerId}: ${testUrl}`);

            const response = await axios.get(testUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
                    'Accept': config.type === 'api' ? 'application/json' : 'text/html,application/xml',
                },
                validateStatus: (status) => status < 500
            });

            const responseTime = Date.now() - startTime;

            // Check for Cloudflare blocks
            const responseText = typeof response.data === 'string' ? response.data : '';
            if (response.status === 403 || responseText.toLowerCase().includes('cloudflare')) {
                console.log(`[HealthCheck] ${indexerId} (${domain}): Cloudflare blocked`);
                continue; // Try next domain
            }

            // Validate response content
            const isValid = config.validateResponse(response.data);
            if (!isValid) {
                console.log(`[HealthCheck] ${indexerId} (${domain}): Invalid response`);
                continue;
            }

            console.log(`[HealthCheck] ${indexerId} (${domain}): SUCCESS in ${responseTime}ms`);
            return {
                success: true,
                responseTime,
                workingDomain: domain,
                error: null
            };

        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.log(`[HealthCheck] ${indexerId} (${domain}): FAILED - ${error.message}`);
            // Continue to next domain
        }
    }

    return {
        success: false,
        responseTime: 0,
        error: 'All domains failed',
        workingDomain: null
    };
}

/**
 * Run health checks for all public indexers
 */
export async function runHealthChecks() {
    console.log('[HealthCheck] Starting health checks for all public indexers...');

    const results = {};
    const indexerIds = Object.keys(PUBLIC_INDEXERS);

    // Run checks in parallel with concurrency limit
    const checkPromises = indexerIds.map(async (indexerId) => {
        const result = await checkIndexer(indexerId);
        results[indexerId] = result;
        return { indexerId, ...result };
    });

    const checkResults = await Promise.allSettled(checkPromises);

    // Update database with results
    for (const result of checkResults) {
        if (result.status === 'fulfilled') {
            const { indexerId, success, responseTime, workingDomain, error } = result.value;
            await updateHealthMetrics(indexerId, success, responseTime, workingDomain, error);
        }
    }

    console.log('[HealthCheck] Health checks complete');
    return results;
}

/**
 * Update health metrics in database
 */
async function updateHealthMetrics(indexerId, success, responseTime, workingDomain, error) {
    if (!supabase) {
        console.warn('[HealthCheck] Supabase not configured, skipping DB update');
        return;
    }

    try {
        // First, get current metrics
        const { data: current } = await supabase
            .from('indexer_health')
            .select('*')
            .eq('id', indexerId)
            .single();

        const totalChecks = (current?.total_checks || 0) + 1;
        const totalSuccesses = (current?.total_successes || 0) + (success ? 1 : 0);
        const totalFailures = (current?.total_failures || 0) + (success ? 0 : 1);
        const successRate = (totalSuccesses / totalChecks) * 100;

        // Calculate rolling average response time
        const prevAvg = current?.avg_response_ms || 0;
        const avgResponseMs = success
            ? Math.round((prevAvg * (totalSuccesses - 1) + responseTime) / totalSuccesses)
            : prevAvg;

        // Calculate priority score (higher = better)
        // Formula: 40% success rate + 40% speed score + 20% recency
        const speedScore = success ? Math.max(0, 100 - (responseTime / 100)) : 0;
        const priority = Math.round(
            (successRate * 0.4) +
            (speedScore * 0.4) +
            (success ? 20 : 0) // Recency bonus for working indexers
        );

        const updateData = {
            id: indexerId,
            is_public: true,
            is_enabled: true,
            last_check: new Date().toISOString(),
            last_success: success ? new Date().toISOString() : current?.last_success,
            success_rate: successRate.toFixed(2),
            avg_response_ms: avgResponseMs,
            total_checks: totalChecks,
            total_successes: totalSuccesses,
            total_failures: totalFailures,
            last_error: success ? null : error,
            working_domain: success ? workingDomain : current?.working_domain,
            priority,
            updated_at: new Date().toISOString()
        };

        const { error: upsertError } = await supabase
            .from('indexer_health')
            .upsert(updateData, { onConflict: 'id' });

        if (upsertError) {
            console.error(`[HealthCheck] Failed to update metrics for ${indexerId}:`, upsertError.message);
        } else {
            console.log(`[HealthCheck] Updated ${indexerId}: success=${success}, priority=${priority}, avgMs=${avgResponseMs}`);
        }

    } catch (err) {
        console.error(`[HealthCheck] Error updating metrics for ${indexerId}:`, err.message);
    }
}

/**
 * Get prioritized list of working indexers
 * Returns indexers sorted by priority (best first)
 */
export async function getWorkingIndexers(options = {}) {
    const { minSuccessRate = 50, maxResponseMs = 5000, limit = 10 } = options;

    if (!supabase) {
        // Return default list if no DB
        return Object.keys(PUBLIC_INDEXERS);
    }

    try {
        const { data, error } = await supabase
            .from('indexer_health')
            .select('id, priority, success_rate, avg_response_ms, working_domain')
            .eq('is_public', true)
            .eq('is_enabled', true)
            .gte('success_rate', minSuccessRate)
            .lte('avg_response_ms', maxResponseMs)
            .order('priority', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('[HealthCheck] Failed to fetch working indexers:', error.message);
            return Object.keys(PUBLIC_INDEXERS);
        }

        return data.map(row => ({
            id: row.id,
            priority: row.priority,
            successRate: row.success_rate,
            avgResponseMs: row.avg_response_ms,
            workingDomain: row.working_domain
        }));

    } catch (err) {
        console.error('[HealthCheck] Error fetching working indexers:', err.message);
        return Object.keys(PUBLIC_INDEXERS);
    }
}

/**
 * Get health status summary
 */
export async function getHealthSummary() {
    if (!supabase) {
        return { error: 'Database not configured' };
    }

    try {
        const { data, error } = await supabase
            .from('indexer_health')
            .select('*')
            .eq('is_public', true)
            .order('priority', { ascending: false });

        if (error) throw error;

        const summary = {
            totalIndexers: data.length,
            workingIndexers: data.filter(d => d.success_rate > 50).length,
            avgSuccessRate: data.reduce((sum, d) => sum + parseFloat(d.success_rate || 0), 0) / data.length,
            avgResponseMs: data.reduce((sum, d) => sum + (d.avg_response_ms || 0), 0) / data.length,
            indexers: data.map(d => ({
                id: d.id,
                priority: d.priority,
                successRate: d.success_rate,
                avgResponseMs: d.avg_response_ms,
                lastCheck: d.last_check,
                lastSuccess: d.last_success,
                workingDomain: d.working_domain,
                lastError: d.last_error
            }))
        };

        return summary;

    } catch (err) {
        return { error: err.message };
    }
}

export default { runHealthChecks, getWorkingIndexers, getHealthSummary };
