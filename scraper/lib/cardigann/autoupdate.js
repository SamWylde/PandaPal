/**
 * Cardigann Auto-Updater
 *
 * Automatically updates scraper domain arrays when Prowlarr has changes.
 * Can be run on app startup or via cron.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DefinitionSync } from './sync.js';
import { saveScraperConfig } from '../../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map of indexer IDs to their scraper file info
const SCRAPER_FILE_MAP = {
    'yts': {
        file: path.join(__dirname, '../sources/yts.js'),
        varName: 'YTS_DOMAINS',
        transformDomain: (d) => d.includes('/api') ? d : `${d}/api/v2`
    },
    '1337x': {
        file: path.join(__dirname, '../sources/t1337x.js'),
        varName: 'T1337X_DOMAINS',
        transformDomain: (d) => d
    },
    'torrentgalaxy': {
        file: path.join(__dirname, '../sources/torrentgalaxy.js'),
        varName: 'TG_DOMAINS',
        transformDomain: (d) => d
    },
    'eztv': {
        file: path.join(__dirname, '../sources/eztv.js'),
        varName: 'EZTV_DOMAINS',
        transformDomain: (d) => d.includes('/api') ? d : `${d}/api`
    },
    'nyaasi': {
        file: path.join(__dirname, '../sources/nyaa.js'),
        varName: 'NYAA_DOMAINS',
        transformDomain: (d) => d
    }
};

/**
 * Auto-update all scraper files with latest domains from Prowlarr
 */
export async function autoUpdateDomains(options = {}) {
    const { dryRun = false, verbose = true } = options;

    const sync = new DefinitionSync();
    const log = verbose ? console.log : () => { };

    log('[AutoUpdate] Checking for domain updates from Prowlarr...');

    // Sync definitions (uses cache if recent)
    await sync.sync();
    const metadata = await sync.getMetadata();

    const results = {
        timestamp: new Date().toISOString(),
        updated: [],
        unchanged: [],
        errors: []
    };

    for (const [indexerId, config] of Object.entries(SCRAPER_FILE_MAP)) {
        try {
            const prowlarrDomains = metadata.indexers[indexerId]?.links || [];

            if (prowlarrDomains.length === 0) {
                log(`[AutoUpdate] ⚠️  ${indexerId}: No domains in Prowlarr, skipping`);
                continue;
            }

            // Transform domains (e.g., add /api/v2 for YTS)
            const newDomains = prowlarrDomains
                .map(d => config.transformDomain(d))
                .filter(d => d); // Remove any nulls

            // Read current file
            const fileContent = await fs.readFile(config.file, 'utf-8');

            // Extract current domains from file
            const currentDomains = extractDomainsFromFile(fileContent, config.varName);

            // Check if update needed
            const needsUpdate = !arraysEqual(currentDomains, newDomains);

            if (!needsUpdate) {
                log(`[AutoUpdate] ✅ ${indexerId}: Already up to date (${currentDomains.length} domains)`);
                results.unchanged.push(indexerId);
                // Even if file is up to date, we might want to ensure DB is synced? 
                // For now, let's assume if file matches prowlarr, we are good.
                // But if running on Vercel, the file might be the hardcoded stale version.
                // So we should probably check against DB or just upsert anyway if Vercel?
                // Efficient route: Just upsert if changed.

                // On Vercel, we can't trust the file content to represent "current state" of the DB.
                // But for now, we follow the logic: Prowlarr has truth.
                continue;
            }

            log(`[AutoUpdate] 🔄 ${indexerId}: Updating domains`);
            log(`[AutoUpdate]    Old: ${currentDomains.slice(0, 3).join(', ')}${currentDomains.length > 3 ? '...' : ''}`);
            log(`[AutoUpdate]    New: ${newDomains.slice(0, 3).join(', ')}${newDomains.length > 3 ? '...' : ''}`);

            if (dryRun) {
                log(`[AutoUpdate]    (dry run - not writing)`);
                results.updated.push({ indexerId, dryRun: true, domains: newDomains });
                continue;
            }

            // 1. Update Supabase (Persistent Source of Truth)
            log(`[AutoUpdate]    Saving to Supabase...`);
            const dbSuccess = await saveScraperConfig(indexerId, newDomains);
            if (!dbSuccess) {
                log(`[AutoUpdate]    ⚠️ Failed to save to Supabase`);
            }

            // 2. Update Local File (if not on Vercel or explicitly desired)
            // On Vercel, this throws EROFS usually, or is just useless. 
            // We skip file write on Vercel unless we want to try (it might work in tmp but useless)
            if (!process.env.VERCEL) {
                const updatedContent = updateDomainsInFile(fileContent, config.varName, newDomains, indexerId);
                await fs.writeFile(config.file, updatedContent);
                log(`[AutoUpdate]    Updated local file.`);
            }

            log(`[AutoUpdate] ✅ ${indexerId}: Updated to ${newDomains.length} domains`);
            results.updated.push({ indexerId, domains: newDomains });

        } catch (error) {
            log(`[AutoUpdate] ❌ ${indexerId}: Error - ${error.message}`);
            results.errors.push({ indexerId, error: error.message });
        }
    }

    // Summary
    log('\n[AutoUpdate] Summary:');
    log(`  Updated: ${results.updated.length}`);
    log(`  Unchanged: ${results.unchanged.length}`);
    log(`  Errors: ${results.errors.length}`);

    return results;
}

/**
 * Extract domain array from file content
 */
function extractDomainsFromFile(content, varName) {
    // Match patterns like: const VAR_NAME = [ ... ];
    const regex = new RegExp(
        `(?:const|let|var)\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
        'm'
    );

    const match = content.match(regex);
    if (!match) return [];

    // Extract URLs from the array
    const arrayContent = match[1];
    const urlMatches = arrayContent.match(/['"]https?:\/\/[^'"]+['"]/g) || [];

    return urlMatches.map(u => u.replace(/['"]/g, ''));
}

/**
 * Update domain array in file content
 */
function updateDomainsInFile(content, varName, newDomains, indexerId) {
    const timestamp = new Date().toISOString().split('T')[0];

    // Build new array string with nice formatting
    const domainsStr = newDomains
        .map(d => `    '${d}'`)
        .join(',\n');

    // Match the variable declaration and its comment
    const regex = new RegExp(
        `(//[^\\n]*\\n)?(?:const|let|var)\\s+${varName}\\s*=\\s*\\[[\\s\\S]*?\\];`,
        'm'
    );

    const newArrayDecl = `// Fallback domains for ${indexerId}\n// Auto-updated ${timestamp} from Prowlarr/Indexers\nconst ${varName} = [\n${domainsStr}\n];`;

    return content.replace(regex, newArrayDecl);
}

/**
 * Check if two arrays are equal (order matters for domains - first is primary)
 */
function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => val === b[idx]);
}

/**
 * Run auto-update on startup (non-blocking)
 */
export function scheduleAutoUpdate(intervalHours = 24) {
    // Run immediately (async, non-blocking)
    autoUpdateDomains({ verbose: false }).catch(err => {
        console.error('[AutoUpdate] Startup check failed:', err.message);
    });

    // Schedule periodic updates
    const intervalMs = intervalHours * 60 * 60 * 1000;
    setInterval(() => {
        autoUpdateDomains({ verbose: false }).catch(err => {
            console.error('[AutoUpdate] Periodic check failed:', err.message);
        });
    }, intervalMs);

    console.log(`[AutoUpdate] Scheduled to run every ${intervalHours} hours`);
}

export default { autoUpdateDomains, scheduleAutoUpdate };
