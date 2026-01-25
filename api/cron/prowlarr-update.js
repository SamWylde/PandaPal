/**
 * Prowlarr Definition Update Cron Endpoint
 *
 * Syncs indexer definitions from Prowlarr/Indexers GitHub repo.
 * Updates domain lists and content types in Supabase.
 * Run via Vercel cron: GET /api/cron/prowlarr-update
 *
 * This is SEPARATE from health checks to give URL testing more time.
 * - This job: Syncs YAML definitions from GitHub (~60s)
 * - Health check job: Tests if domains actually work
 */

import { autoUpdateDomains } from '../../scraper/lib/cardigann/autoupdate.js';

// Hospital-grade timeout wrapper
const withTimeout = (promise, ms, errorMsg) => {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(errorMsg)), ms)
    );
    return Promise.race([promise, timeout]);
};

// Sync typically takes 15-60s depending on GitHub response time
const MAX_SYNC_TIMEOUT_MS = 120000; // 2 minutes max

export default async function handler(req, res) {
    try {
        console.log('[Cron:Prowlarr] Starting definition sync from Prowlarr/Indexers...');
        const startTime = Date.now();

        const results = await withTimeout(
            autoUpdateDomains({ dryRun: false, verbose: true }),
            MAX_SYNC_TIMEOUT_MS,
            'Prowlarr sync timed out after 120s'
        );

        const duration = Date.now() - startTime;

        console.log(`[Cron:Prowlarr] Sync complete in ${duration}ms`);
        console.log(`[Cron:Prowlarr] Updated: ${results.updated.length}, Errors: ${results.errors.length}`);

        res.status(200).json({
            success: true,
            type: 'prowlarr-update',
            duration: `${duration}ms`,
            summary: {
                updated: results.updated.length,
                unchanged: results.unchanged.length,
                errors: results.errors.length
            },
            errors: results.errors.length > 0 ? results.errors : undefined
        });

    } catch (error) {
        console.error('[Cron:Prowlarr] Sync failed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
