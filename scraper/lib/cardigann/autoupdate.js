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
import { saveScraperConfig } from '../db.js';
import { parseCardigannYaml, extractDomains, extractContentTypes } from './parser.js';
import { supabase } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map of indexer IDs to their scraper file info
// Note: Prowlarr names may differ from our local file names
// Key = Prowlarr indexer ID, value = local scraper config
const SCRAPER_FILE_MAP = {
    'yts': {
        file: path.join(__dirname, '../sources/yts.js'),
        varName: 'YTS_FALLBACK',
        transformDomain: (d) => d.includes('/api') ? d : `${d}/api/v2`
    },
    '1337x': {
        file: path.join(__dirname, '../sources/t1337x.js'),
        varName: 'T1337X_FALLBACK',
        transformDomain: (d) => d
    },
    'torrentgalaxyclone': {  // Prowlarr uses 'torrentgalaxyclone', we have torrentgalaxy.js
        file: path.join(__dirname, '../sources/torrentgalaxy.js'),
        varName: 'TG_FALLBACK',
        transformDomain: (d) => d
    },
    'eztv': {
        file: path.join(__dirname, '../sources/eztv.js'),
        varName: 'EZTV_FALLBACK',
        transformDomain: (d) => d.includes('/api') ? d : `${d}/api`
    },
    'nyaasi': {
        file: path.join(__dirname, '../sources/nyaa.js'),
        varName: 'NYAA_FALLBACK',
        transformDomain: (d) => d
    },
    'bitsearch': {
        file: path.join(__dirname, '../sources/bitsearch.js'),
        varName: 'BITSEARCH_FALLBACK',
        transformDomain: (d) => d
    }
};

/**
 * Update content_types in indexer_health table
 * This ensures realtime search knows what content each indexer supports
 */
async function updateIndexerContentTypes(indexerId, contentTypes) {
    if (!supabase) return false;

    try {
        // Upsert to indexer_health - will create if doesn't exist
        const { error } = await supabase
            .from('indexer_health')
            .upsert({
                id: indexerId,
                content_types: contentTypes,
                is_public: true,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (error) {
            console.warn(`[AutoUpdate] Failed to update content_types for ${indexerId}: ${error.message}`);
            return false;
        }
        return true;
    } catch (err) {
        console.warn(`[AutoUpdate] Error updating content_types for ${indexerId}: ${err.message}`);
        return false;
    }
}

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

    // Iterate over ALL synced indexers to update Supabase
    // (Map provides legacy file support, but we want DB to have everything)
    const allIndexers = Object.keys(metadata.indexers);
    log(`[AutoUpdate] Processing ${allIndexers.length} indexers...`);

    for (const indexerId of allIndexers) {
        try {
            // Get definition
            const syncedDefinition = await sync.getDefinition(indexerId);
            if (!syncedDefinition) continue;

            // Parse it
            const fullConfig = parseCardigannYaml(syncedDefinition);
            const newDomains = extractDomains(fullConfig);

            if (newDomains.length === 0) {
                // Skip silence to reduce noise
                continue;
            }

            // Extract content types from the definition (movie, series, anime)
            const contentTypes = extractContentTypes(fullConfig);

            // 1. Update Supabase (ALWAYS)
            // We do this for everyone, not just the mapped ones
            if (!dryRun) {
                const dbSuccess = await saveScraperConfig(indexerId, fullConfig);
                if (dbSuccess) {
                    // Also update content_types in indexer_health table
                    await updateIndexerContentTypes(indexerId, contentTypes);
                } else {
                    results.errors.push({ indexerId, error: "Supabase save failed" });
                }
            } else {
                results.updated.push({ indexerId, dryRun: true, domains: newDomains, contentTypes });
            }

            // 2. Update Local File (Legacy/Mapped Only)
            if (SCRAPER_FILE_MAP[indexerId]) {
                const config = SCRAPER_FILE_MAP[indexerId];

                // Read current file
                const fileContent = await fs.readFile(config.file, 'utf-8');
                const currentDomains = extractDomainsFromFile(fileContent, config.varName);
                const needsUpdate = !arraysEqual(currentDomains, newDomains);

                if (needsUpdate) {
                    log(`[AutoUpdate] 🔄 ${indexerId}: Updating local file domains`);
                    if (!dryRun && !process.env.VERCEL) {
                        const updatedContent = updateDomainsInFile(fileContent, config.varName, newDomains, indexerId);
                        await fs.writeFile(config.file, updatedContent);
                        results.updated.push({ indexerId, domains: newDomains });
                    }
                } else {
                    results.unchanged.push(indexerId);
                }
            } else {
                // Count as updated/processed for stats
                results.updated.push({ indexerId, domains: newDomains, dbOnly: true });
            }

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
