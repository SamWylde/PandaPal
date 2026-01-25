/**
 * Indexer Health Check Cron Endpoint
 *
 * Tests all public indexers and records their performance metrics.
 * Run via Vercel cron or manually: GET /api/cron/health-check
 *
 * Query params:
 *   - summary=true: Return health summary without running checks
 */

import { runHealthChecks, getHealthSummary } from '../../scraper/lib/healthCheck.js';

// Hospital-grade timeout wrapper
const withTimeout = (promise, ms, errorMsg) => {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(errorMsg)), ms)
    );
    return Promise.race([promise, timeout]);
};

// Vercel Pro has 300s (5 min) timeout
// Health checks need time for CF browser challenges (30s each × up to 10 indexers)
// We use 280s to ensure clean response before Vercel kills us
const MAX_CRON_TIMEOUT_MS = 280000;
const MAX_SUMMARY_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
    try {
        // If just requesting summary, don't run checks
        if (req.query.summary === 'true') {
            const summary = await withTimeout(
                getHealthSummary(),
                MAX_SUMMARY_TIMEOUT_MS,
                'Health summary timed out'
            );
            return res.status(200).json({
                success: true,
                type: 'summary',
                data: summary
            });
        }

        console.log('[Cron] Starting indexer health checks...');
        const startTime = Date.now();

        const results = await withTimeout(
            runHealthChecks(),
            MAX_CRON_TIMEOUT_MS,
            'Health check timed out after 280s (CF challenges may need more time)'
        );

        const duration = Date.now() - startTime;
        const successCount = Object.values(results).filter(r => r.success).length;
        const totalCount = Object.keys(results).length;

        console.log(`[Cron] Health checks complete: ${successCount}/${totalCount} working in ${duration}ms`);

        res.status(200).json({
            success: true,
            type: 'health-check',
            duration: `${duration}ms`,
            summary: {
                total: totalCount,
                working: successCount,
                failed: totalCount - successCount
            },
            results
        });

    } catch (error) {
        console.error('[Cron] Health check failed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
