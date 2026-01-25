/**
 * Indexer Health Check Service
 *
 * Tests all PUBLIC indexers and records their performance metrics.
 * Results are stored in Supabase for prioritizing fast/reliable indexers.
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { getScraperConfig } from './db.js';
import { PUBLIC_INDEXERS, DefinitionSync } from './cardigann/sync.js';
import { parseCardigannYaml, extractSearchConfig } from './cardigann/parser.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// Test query values
const TEST_QUERY = 'Inception';
const TEST_IMDB_ID = 'tt1375666';

// Public indexers only - NO private/login-required indexers
// IDs must match Prowlarr indexer IDs (used for DB lookup)
// (Now using generic list from sync.js)

// Initialize sync helper
const sync = new DefinitionSync();

/**
 * Run health check for a single indexer (Generic Logic)
 */
async function checkIndexer(indexerId) {
    // 1. Get domains from database
    const scraperConfig = await getScraperConfig(indexerId);
    let domains = scraperConfig?.links || [];

    if (domains.length === 0) {
        // Fallback: try to get from definitions if not in DB yet
        try {
            const def = await sync.getDefinition(indexerId);
            if (def) {
                const parsed = parseCardigannYaml(def);
                domains = parsed.links || [];
            }
        } catch (e) { }
    }

    if (domains.length === 0) {
        return { success: false, error: 'No domains configured', responseTime: 0 };
    }

    // 2. Get definition to construct path
    let searchPath = '/';
    let checkType = 'html';

    try {
        const defContent = await sync.getDefinition(indexerId);
        if (defContent) {
            const parsed = parseCardigannYaml(defContent);
            const searchConfig = extractSearchConfig(parsed);

            // Determine type (API or HTML)
            if (parsed.search?.response?.type === 'json' ||
                (parsed.search?.paths?.[0]?.path || '').includes('api')) {
                checkType = 'api';
            }

            // Find a suitable search path
            if (searchConfig.paths && searchConfig.paths.length > 0) {
                let rawPath = searchConfig.paths[0].path; // Use first path

                // Replace variables
                searchPath = rawPath
                    .replace('{{ .Keywords }}', TEST_QUERY)
                    .replace('{{ .Query.IMDBID }}', TEST_IMDB_ID)
                    .replace('{{ .Query.Page }}', '1')
                    .replace('{{ .Config.sitelink }}', '')

                    // Handle {{ if ... }}...{{ else }}...{{ end }} - taking first branch for Keywords/IMDBID logic
                    .replace(/{{ if .*? }}(.*?){{ else }}.*?{{ end }}/g, '$1')

                    // Handle {{ if ... }}...{{ end }} - take content
                    .replace(/{{ if .*? }}(.*?){{ end }}/g, '$1')

                    // Cleanup remaining tags
                    .replace(/{{.*?}}/g, '')

                    // Cleanup double slashes or weird artifacts
                    .replace(/\/+/g, '/'); // careful with protocol

                // Ensure leading slash isn't double
                if (!searchPath.startsWith('/')) searchPath = '/' + searchPath;
            }
        }
    } catch (e) {
        console.warn(`[HealthCheck] Failed to parse definition for ${indexerId}, using default root path`);
    }

    // 3. Test each domain
    let lastError = null;
    for (const domain of domains) {
        const startTime = Date.now();
        // Remove trailing slash from domain to avoid double slash with searchPath
        const cleanDomain = domain.replace(/\/$/, '');
        const testUrl = `${cleanDomain}${searchPath}`;

        try {
            console.log(`[HealthCheck] Testing ${indexerId}: ${testUrl}`);

            const response = await axios.get(testUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
                    'Accept': checkType === 'api' ? 'application/json' : 'text/html,application/xml',
                },
                validateStatus: (status) => status < 500
            });

            const responseTime = Date.now() - startTime;

            // Check for Cloudflare blocks
            const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            if (response.status === 403 || responseText.toLowerCase().includes('cloudflare')) {
                console.log(`[HealthCheck] ${indexerId} (${domain}): Cloudflare blocked`);
                lastError = 'Cloudflare blocked';
                continue; // Try next domain
            }

            // Basic validation
            let isValid = true;
            if (checkType === 'api') {
                // For API, ensure we got JSON (axios auto-parses) and it's not empty
                isValid = typeof response.data === 'object';
            } else {
                // For HTML, ensure we got some content
                isValid = responseText.length > 500;
            }

            if (!isValid) {
                console.log(`[HealthCheck] ${indexerId} (${domain}): Invalid response`);
                lastError = 'Invalid response';
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
            console.log(`[HealthCheck] ${indexerId} (${domain}): FAILED - ${error.message}`);
            lastError = error.message;
            // Continue to next domain
        }
    }

    return {
        success: false,
        responseTime: 0,
        error: lastError || 'All domains failed',
        workingDomain: null
    };
}

/**
 * Run health checks for all public indexers
 */
export async function runHealthChecks() {
    console.log(`[HealthCheck] Starting health checks for ${PUBLIC_INDEXERS.length} public indexers...`);

    const results = {};

    // Batch processing to avoid overwhelming node (concurrency: 5)
    for (let i = 0; i < PUBLIC_INDEXERS.length; i += 5) {
        const batch = PUBLIC_INDEXERS.slice(i, i + 5);
        const batchPromises = batch.map(async (indexerId) => {
            const result = await checkIndexer(indexerId);
            results[indexerId] = result;

            // Save to DB
            await updateHealthMetrics(indexerId, result.success, result.responseTime, result.workingDomain, result.error);

            return { indexerId, ...result };
        });

        await Promise.allSettled(batchPromises);
    }

    console.log('[HealthCheck] Health checks complete');
    return results;
}

/**
 * Update health metrics in database
 */
async function updateHealthMetrics(indexerId, success, responseTime, workingDomain, error) {
    if (!supabase) {
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
            console.error(`[HealthCheck] Failed DB update for ${indexerId}: ${upsertError.message}`);
        } else {
            const errorSuffix = success ? '' : `, error=${error || 'unknown'}`;
            console.log(`[HealthCheck] Updated ${indexerId}: success=${success}, priority=${priority}${errorSuffix}`);
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
    const { minSuccessRate = 20, maxResponseMs = 10000, limit = 20 } = options;

    if (!supabase) {
        // Return default list if no DB
        return PUBLIC_INDEXERS;
    }

    try {
        const { data, error } = await supabase
            .from('indexer_health')
            .select('id, priority, success_rate, avg_response_ms, working_domain')
            .eq('is_public', true)
            .eq('is_enabled', true)
            // Relaxed constraints for now
            .order('priority', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('[HealthCheck] Failed to fetch working indexers:', error.message);
            return PUBLIC_INDEXERS;
        }

        if (data.length === 0) return PUBLIC_INDEXERS;

        return data.map(row => ({
            id: row.id,
            priority: row.priority,
            successRate: row.success_rate,
            avgResponseMs: row.avg_response_ms,
            workingDomain: row.working_domain
        }));

    } catch (err) {
        console.error('[HealthCheck] Error fetching working indexers:', err.message);
        return PUBLIC_INDEXERS;
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
            avgSuccessRate: data.reduce((sum, d) => sum + parseFloat(d.success_rate || 0), 0) / data.length || 0,
            avgResponseMs: data.reduce((sum, d) => sum + (d.avg_response_ms || 0), 0) / data.length || 0,
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
