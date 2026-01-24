import { autoUpdateDomains } from '../../scraper/lib/cardigann/autoupdate.js';

export default async function handler(req, res) {
    try {
        // Authenticate cron request (Vercel automatically sets this header)
        const authHeader = req.headers['authorization'];
        // In production, verify this matches CRON_SECRET if configured

        const forceUpdate = req.query.force === 'true';

        console.log('[Cron] Starting domain auto-update...');
        const results = await autoUpdateDomains({
            dryRun: !forceUpdate && process.env.VERCEL, // Default to dry-run on Vercel unless forced, to avoid FS errors
            verbose: true
        });

        res.status(200).json({
            success: true,
            results,
            note: process.env.VERCEL ? "Updates on Vercel are ephemeral/read-only." : "Updates applied to disk."
        });
    } catch (error) {
        console.error('[Cron] Update failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}
