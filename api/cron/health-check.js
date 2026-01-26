/**
 * Indexer Health Check Cron Endpoint
 *
 * Tests all public indexers and records their performance metrics.
 * Run via Vercel cron or manually: GET /api/cron/health-check
 *
 * Query params:
 *   - summary=true: Return health summary without running checks
 *   - force=true: Bypass cron lock and run anyway
 */

import { runHealthChecks, getHealthSummary } from '../../scraper/lib/healthCheck.js';
import { supabase } from '../../scraper/lib/db.js';

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
const LOCK_EXPIRY_MS = 10 * 60 * 1000; // Lock expires after 10 minutes (failsafe)

/**
 * Simple cron lock using Supabase
 * Prevents multiple health check instances from running simultaneously
 */
async function acquireCronLock(jobName) {
    if (!supabase) return { acquired: true, release: () => {} };

    const now = new Date();
    const lockId = `${jobName}-lock`;

    try {
        // Check for existing lock
        const { data: existing } = await supabase
            .from('cron_locks')
            .select('*')
            .eq('id', lockId)
            .single();

        if (existing) {
            const lockedAt = new Date(existing.locked_at);
            const elapsed = now - lockedAt;

            // If lock is still fresh (< 10 min), another instance is running
            if (elapsed < LOCK_EXPIRY_MS) {
                console.log(`[Cron] Lock held by another instance (${Math.round(elapsed / 1000)}s ago)`);
                return { acquired: false, existingLock: existing };
            }
            // Lock is stale, we can override it
            console.log(`[Cron] Found stale lock (${Math.round(elapsed / 1000)}s old), overriding`);
        }

        // Acquire lock
        const { error } = await supabase
            .from('cron_locks')
            .upsert({
                id: lockId,
                locked_at: now.toISOString(),
                locked_by: `vercel-${process.env.VERCEL_REGION || 'unknown'}`
            }, { onConflict: 'id' });

        if (error) {
            console.error('[Cron] Failed to acquire lock:', error.message);
            return { acquired: true, release: () => {} }; // Proceed anyway on error
        }

        console.log(`[Cron] Lock acquired for ${jobName}`);

        return {
            acquired: true,
            release: async () => {
                try {
                    await supabase.from('cron_locks').delete().eq('id', lockId);
                    console.log(`[Cron] Lock released for ${jobName}`);
                } catch (err) {
                    console.error('[Cron] Failed to release lock:', err.message);
                }
            }
        };
    } catch (err) {
        console.error('[Cron] Lock check failed:', err.message);
        return { acquired: true, release: () => {} }; // Proceed on error
    }
}

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

        // Try to acquire cron lock (unless force=true)
        const forceLock = req.query.force === 'true';
        let lockInfo = { acquired: true, release: () => {} };

        if (!forceLock) {
            lockInfo = await acquireCronLock('health-check');
            if (!lockInfo.acquired) {
                return res.status(200).json({
                    success: true,
                    type: 'skipped',
                    reason: 'Another health check is already running',
                    lockedAt: lockInfo.existingLock?.locked_at
                });
            }
        }

        console.log('[Cron] Starting indexer health checks...');
        const startTime = Date.now();

        let results;
        try {
            results = await withTimeout(
                runHealthChecks(),
                MAX_CRON_TIMEOUT_MS,
                'Health check timed out after 280s (CF challenges may need more time)'
            );
        } finally {
            // Always release lock when done (even on timeout/error)
            await lockInfo.release();
        }

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
