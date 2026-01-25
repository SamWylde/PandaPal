/**
 * Indexer Health Check Service
 *
 * Tests all PUBLIC indexers and records their performance metrics.
 * Results are stored in Supabase for prioritizing fast/reliable indexers.
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { getScraperConfig, supabase } from './db.js';
import { PUBLIC_INDEXERS, DefinitionSync } from './cardigann/sync.js';
import { parseCardigannYaml, extractSearchConfig } from './cardigann/parser.js';
import { solveCFChallenge, getCachedSession, requestWithCFSession } from './cfSolver.js';
import { autoUpdateDomains } from './cardigann/autoupdate.js';

const supabaseUrl = process.env.SUPABASE_URL; // Still needed for passed logic if any? 
// Actually supabase instance is mostly used.

// Test query values

// Test query values
const TEST_QUERY = 'Inception';
const TEST_IMDB_ID = 'tt1375666';

// Initialize sync helper
const sync = new DefinitionSync();

/**
 * Detect specific type of block/challenge from response
 * Based on Prowlarr's CloudFlareDetectionService.cs implementation
 * @see https://github.com/Prowlarr/Prowlarr/blob/develop/src/NzbDrone.Core/Http/CloudFlare/CloudFlareDetectionService.cs
 * Returns null if no block detected
 */
function detectBlockType(response, responseText) {
    const status = response.status;
    const headers = response.headers || {};
    const text = responseText.toLowerCase();
    const server = (headers['server'] || '').toLowerCase();

    // === Prowlarr-style Cloudflare Detection ===
    // Check server header for CF/DDoS-Guard
    const isCfServer = server.includes('cloudflare') || server.includes('cloudflare-nginx');
    const isDdosGuard = server.includes('ddos-guard');

    // Only check content if status is 403 or 503 (Prowlarr's approach)
    if (status === 403 || status === 503) {
        // Cloudflare challenge page titles (exact patterns from Prowlarr)
        if (text.includes('<title>just a moment...</title>')) {
            return 'Cloudflare JS challenge';
        }
        if (text.includes('<title>attention required! | cloudflare</title>')) {
            return 'Cloudflare CAPTCHA challenge';
        }
        if (text.includes('<title>access denied</title>') && isCfServer) {
            return 'Cloudflare access denied';
        }
        if (text.includes('error code: 1020')) {
            return 'Cloudflare error 1020 (IP blocked)';
        }

        // DDoS-Guard detection (from Prowlarr)
        if (text.includes('<title>ddos-guard</title>') || isDdosGuard) {
            return 'DDoS-Guard block';
        }

        // Custom CF detection: Vary header + ddos in content (from Prowlarr)
        const varyHeader = headers['vary'] || '';
        if (varyHeader === 'Accept-Encoding,User-Agent' && text.includes('ddos')) {
            return 'DDoS protection (custom)';
        }

        // Generic Cloudflare block (server header confirms CF)
        if (isCfServer) {
            return `Cloudflare block (${status})`;
        }
    }

    // === Additional FlareSolverr-style detection ===
    // These patterns indicate CF challenge even without 403/503
    if (text.includes('id="cf-challenge-running"') ||
        text.includes('id="cf-please-wait"') ||
        text.includes('id="challenge-spinner"') ||
        text.includes('id="turnstile-wrapper"') ||
        text.includes('class="cf-error-title"')) {
        return 'Cloudflare challenge page';
    }

    // === Other WAF/Protection Services ===
    // Sucuri WAF
    if (text.includes('sucuri') && (status === 403 || text.includes('access denied'))) {
        return 'Sucuri WAF block';
    }

    // Akamai
    if (text.includes('akamai') && status === 403) {
        return 'Akamai block';
    }

    // Rate limiting
    if (status === 429) {
        return 'Rate limited (429)';
    }

    // Generic 403 without WAF signature
    if (status === 403) {
        return 'HTTP 403 Forbidden';
    }

    // 503 without protection service
    if (status === 503) {
        return 'Service unavailable (503)';
    }

    return null;
}

/**
 * Run health check for a single indexer (Generic Logic)
 */
async function checkIndexer(indexerId) {
    // 1. Get domains from database
    const scraperConfig = await getScraperConfig(indexerId);
    let domains = scraperConfig?.links || [];

    if (domains.length === 0) {
        // Fallback: try to get from synced definitions metadata
        try {
            domains = await sync.getDomains(indexerId);
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

                    // Cleanup quotes that might have been part of the template
                    .replace(/"/g, '')

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

            // Check for cached CF session first
            const domainHost = new URL(cleanDomain).hostname;
            const cachedSession = await getCachedSession(domainHost);

            let response;
            if (cachedSession) {
                console.log(`[HealthCheck] ${indexerId}: Using cached CF session`);
                response = await requestWithCFSession(testUrl, cachedSession, axios);
            } else {
                response = await axios.get(testUrl, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
                        'Accept': checkType === 'api' ? 'application/json' : 'text/html,application/xml',
                    },
                    validateStatus: (status) => status < 500
                });
            }

            const responseTime = Date.now() - startTime;
            const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            // Check for various block types (Cloudflare, WAF, rate limiting, etc.)
            const blockType = detectBlockType(response, responseText);
            if (blockType) {
                console.log(`[HealthCheck] ${indexerId} (${domain}): ${blockType}`);

                // Attempt CF bypass if it's a Cloudflare block
                if (blockType.toLowerCase().includes('cloudflare')) {
                    console.log(`[HealthCheck] ${indexerId}: Attempting CF bypass...`);
                    try {
                        const cfResult = await solveCFChallenge(testUrl, { timeout: 30000 });
                        if (cfResult.success) {
                            // Retry with CF cookies
                            console.log(`[HealthCheck] ${indexerId}: CF solved, retrying with cookies...`);
                            const retryResponse = await requestWithCFSession(testUrl, cfResult, axios);
                            const retryTime = Date.now() - startTime;
                            const retryText = typeof retryResponse.data === 'string'
                                ? retryResponse.data
                                : JSON.stringify(retryResponse.data);

                            // Check if retry worked
                            const retryBlockType = detectBlockType(retryResponse, retryText);
                            if (!retryBlockType && retryText.length > 500) {
                                console.log(`[HealthCheck] ${indexerId} (${domain}): CF BYPASS SUCCESS in ${retryTime}ms`);
                                return {
                                    success: true,
                                    responseTime: retryTime,
                                    workingDomain: domain,
                                    error: null,
                                    cfBypassed: true
                                };
                            } else {
                                console.log(`[HealthCheck] ${indexerId}: CF bypass failed - still blocked: ${retryBlockType || 'invalid response'}`);
                            }
                        } else {
                            console.log(`[HealthCheck] ${indexerId}: CF solver failed: ${cfResult.error}`);
                        }
                    } catch (cfError) {
                        console.log(`[HealthCheck] ${indexerId}: CF bypass error: ${cfError.message}`);
                    }
                }

                lastError = blockType;
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
 * Run health checks for a subset of public indexers (Batch: 10)
 * To prevent Vercel timeouts, we only check the 10 oldest/unchecked indexers per run.
 * With an hourly cron, this covers 240 indexers/day.
 */
export async function runHealthChecks() {
    console.log('[HealthCheck] Starting health check job...');

    // 1. Ensure definitions are synced
    try {
        console.log('[HealthCheck] Syncing definitions & updating DB...');
        await autoUpdateDomains({ dryRun: false, verbose: false });
    } catch (syncError) {
        console.error(`[HealthCheck] Failed to sync definitions: ${syncError.message}`);
    }

    // 2. Identify which indexers to check (Priority: Never checked > Oldest checked)
    let candidates = [];

    if (supabase) {
        // Fetch current health status
        const { data: healthData, error } = await supabase
            .from('indexer_health')
            .select('id, last_check');

        const dbMap = new Map((healthData || []).map(r => [r.id, r.last_check]));

        // Build list of all indexers with their "last check" time
        candidates = PUBLIC_INDEXERS.map(id => {
            const lastCheck = dbMap.get(id);
            return {
                id,
                // If never checked, use timestamp 0 to prioritize it
                timestamp: lastCheck ? new Date(lastCheck).getTime() : 0
            };
        });

        // Sort: Ascending timestamp (0 first, then oldest dates)
        candidates.sort((a, b) => a.timestamp - b.timestamp);
    } else {
        // Fallback if no DB: just take first 10
        candidates = PUBLIC_INDEXERS.map(id => ({ id, timestamp: 0 }));
    }

    // 3. Select top 10
    const BATCH_SIZE = 10;
    const batch = candidates.slice(0, BATCH_SIZE);

    console.log(`[HealthCheck] Processing batch of ${batch.length} indexers (out of ${PUBLIC_INDEXERS.length} total)`);
    console.log(`[HealthCheck] Targets: ${batch.map(b => b.id).join(', ')}`);

    const results = {};

    // 4. Run checks (Sequentially 1 by 1)
    // We run sequentially to avoid triggering Cloudflare rate limits and to save Vercel memory.
    for (const candidate of batch) {
        try {
            console.log(`[HealthCheck] Checking ${candidate.id}...`);
            const result = await checkIndexer(candidate.id);
            results[candidate.id] = result;

            // Save to DB (Update last_check)
            await updateHealthMetrics(candidate.id, result.success, result.responseTime, result.workingDomain, result.error);

            // Small delay between checks to be "nice"
            await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
            console.error(`[HealthCheck] Critical error checking ${candidate.id}:`, err);
        }
    }

    console.log('[HealthCheck] Batch complete.');
    return results;
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
