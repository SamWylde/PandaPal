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
import { parseCardigannYaml, extractDomains } from './parser.js';

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
            // Parse full definition from YAML
            // We get definition from file path now, or better:
            // sync.sync() creates the files. We should read them.
            // But wait, sync.js logic saves .yml to cacheDir.
            // We need to read that .yml file here.

            // Actually, we can just read the synced file
            const syncedDefinition = await sync.getDefinition(indexerId);
            if (!syncedDefinition) {
                log(`[AutoUpdate] ⚠️ ${indexerId}: Synced definition not found?`);
                continue;
            }

            // Parse it
            const fullConfig = parseCardigannYaml(syncedDefinition);
            const newDomains = extractDomains(fullConfig);

            if (newDomains.length === 0) {
                log(`[AutoUpdate] ⚠️  ${indexerId}: No domains found in definition, skipping`);
                continue;
            }

            // Read current file
            const fileContent = await fs.readFile(config.file, 'utf-8');

            // Extract current domains from file
            const currentDomains = extractDomainsFromFile(fileContent, config.varName);

            // Check if update needed (based on domains for now, preserving log noise)
            const needsUpdate = !arraysEqual(currentDomains, newDomains);

            if (!needsUpdate) {
                log(`[AutoUpdate] ✅ ${indexerId}: Already up to date (${currentDomains.length} domains)`);
                results.unchanged.push(indexerId);
                // Still upsert to DB if it's missing or if we want to ensure latest config is there
                // For simplicity, we only skip if we are 100% sure DB is fresh.
                // But honestly, saving to DB is cheap. Let's do it if we are this deep in logic.
                // Actually, let's stick to "if needsUpdate" OR "if forced".
                // But wait, if local file is up to date, it doesn't mean DB is.
                // Let's force save to DB if running in cron? 
                // No, let's keep logic: if domains changed, update everywhere.
                // BUT: if this is a fresh deployment, local file might be old while Prowlarr is new.
                // "needsUpdate" compares Prowlarr domains vs Local File domains.
                // So if Prowlarr has new domains, we proceed.
                if (!process.env.FORCE_DB_UPDATE) continue;
            }

            log(`[AutoUpdate] 🔄 ${indexerId}: Updating domains`);
            log(`[AutoUpdate]    Old: ${currentDomains.slice(0, 3).join(', ')}${currentDomains.length > 3 ? '...' : ''}`);
            log(`[AutoUpdate]    New: ${newDomains.slice(0, 3).join(', ')}${newDomains.length > 3 ? '...' : ''}`);

            if (dryRun) {
                log(`[AutoUpdate]    (dry run - not writing)`);
                results.updated.push({ indexerId, dryRun: true, domains: newDomains });
                continue;
            }

            // 1. Update Supabase (Full Config)
            log(`[AutoUpdate]    Saving config to Supabase...`);
            const dbSuccess = await saveScraperConfig(indexerId, fullConfig);
            if (!dbSuccess) {
                log(`[AutoUpdate]    ⚠️ Failed to save to Supabase`);
            }

            // 2. Update Local File (Legacy Domain List support)
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
