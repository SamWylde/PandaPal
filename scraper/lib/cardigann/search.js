/**
 * Cardigann Search Interface
 *
 * High-level search functions using Cardigann definitions.
 * Provides easy integration with existing scraper infrastructure.
 */

import { DefinitionSync } from './sync.js';
import { CardigannEngine } from './engine.js';
import { getScraperConfig } from '../db.js';

// Singleton instances
let syncInstance = null;
let engineInstance = null;
let initialized = false;

/**
 * Initialize Cardigann system
 */
async function ensureInitialized() {
    if (initialized) return;

    // Initialize singletons if needed
    if (!syncInstance) syncInstance = new DefinitionSync();
    if (!engineInstance) engineInstance = new CardigannEngine();

    // We NO LONGER auto-sync here during search.
    // Syncing is handled by the health-check cron job.
    // We only initialize the engine.
    initialized = true;
}

/**
 * Get list of available indexers with their current domains
 */
export async function getAvailableIndexers() {
    await ensureInitialized();

    const metadata = await syncInstance.getMetadata();
    const indexers = [];

    for (const [id, info] of Object.entries(metadata.indexers || {})) {
        indexers.push({
            id,
            name: info.name || id,
            type: info.type || 'public',
            language: info.language || 'en-US',
            domains: info.links || [],
            lastSync: metadata.lastSync
        });
    }

    return indexers;
}

/**
 * Get current working domains for a specific indexer
 * Useful for updating hardcoded domain lists
 */
export async function getIndexerDomains(indexerId) {
    await ensureInitialized();
    return await syncInstance.getDomains(indexerId);
}

/**
 * Search using a specific Cardigann indexer
 */
export async function searchWithCardigann(indexerId, query, options = {}) {
    await ensureInitialized();

    // 1. Try to get config from Database (Supabase)
    // This is the "Hospital Standard" reliable path: Read from the Source of Truth maintained by Cron.
    try {
        const dbConfig = await getScraperConfig(indexerId);
        if (dbConfig) {
            // Found in DB! Use this directly. No GitHub sync needed.
            const result = await engineInstance.search(dbConfig, query, options);
            if (result.success) {
                return result.results.map(r => ({
                    ...r,
                    imdbId: options.imdbId,
                    type: options.type || 'movie'
                }));
            }
            return []; // DB config existed but search returned nothing/failed
        }
    } catch (dbError) {
        console.warn(`[Cardigann] Database lookup failed for ${indexerId}, falling back to local/sync: ${dbError.message}`);
    }

    // 2. Fallback: Local/Cached Definition (Legacy/Backup path)
    // Only happens if DB is empty or unreachable.
    // This parses the YAML file from cache (or downloads if missing).

    // We might need to ensure sync was actually done if we are here?
    // But we disabled auto-sync in ensureInitialized to stop the spam.
    // So we check if we have the definition.
    let definition = await syncInstance.getDefinition(indexerId);

    // If missing, absolutely force a sync for this specific one (rare case)
    if (!definition) {
        // Double check if we need to sync
        console.log(`[Cardigann] Definition missing for ${indexerId}, attempting emergency sync...`);
        await syncInstance.sync(false); // sync if needed
        definition = await syncInstance.getDefinition(indexerId);
    }

    if (!definition) {
        console.error(`[Cardigann] No definition found for: ${indexerId}`);
        return [];
    }

    const result = await engineInstance.search(definition, query, options);

    if (result.success) {
        return result.results.map(r => ({
            ...r,
            imdbId: options.imdbId,
            type: options.type || 'movie'
        }));
    }

    return [];
}

/**
 * Search multiple indexers in parallel
 */
export async function searchMultipleIndexers(indexerIds, query, options = {}) {
    await ensureInitialized();

    const promises = indexerIds.map(id =>
        searchWithCardigann(id, query, options)
            .catch(err => {
                console.error(`[Cardigann] ${id} search failed:`, err.message);
                return [];
            })
    );

    const results = await Promise.all(promises);
    return results.flat();
}

/**
 * Force refresh definitions from Prowlarr repo
 */
export async function refreshDefinitions() {
    if (!syncInstance) {
        syncInstance = new DefinitionSync();
    }

    return await syncInstance.sync(true);
}

/**
 * Get updated domain list for our existing scrapers
 * This is the key function for auto-updating domains
 */
export async function getUpdatedDomains() {
    await ensureInitialized();

    const metadata = await syncInstance.getMetadata();

    return {
        yts: metadata.indexers['yts']?.links || [],
        '1337x': metadata.indexers['1337x']?.links || [],
        torrentgalaxy: metadata.indexers['torrentgalaxy']?.links || [],
        eztv: metadata.indexers['eztv']?.links || [],
        nyaa: metadata.indexers['nyaasi']?.links || [],
        lastSync: metadata.lastSync,
        source: metadata.source
    };
}

/**
 * Create domain update report
 * Compares current hardcoded domains with Prowlarr's latest
 */
export async function createDomainReport(currentDomains = {}) {
    const updated = await getUpdatedDomains();

    const report = {
        timestamp: new Date().toISOString(),
        source: updated.source,
        lastSync: updated.lastSync,
        indexers: {}
    };

    const indexerMap = {
        yts: { current: currentDomains.yts || [], prowlarr: updated.yts },
        '1337x': { current: currentDomains['1337x'] || [], prowlarr: updated['1337x'] },
        torrentgalaxy: { current: currentDomains.torrentgalaxy || [], prowlarr: updated.torrentgalaxy },
        eztv: { current: currentDomains.eztv || [], prowlarr: updated.eztv },
        nyaa: { current: currentDomains.nyaa || [], prowlarr: updated.nyaa }
    };

    for (const [name, data] of Object.entries(indexerMap)) {
        const currentSet = new Set(data.current.map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')));
        const prowlarrSet = new Set(data.prowlarr.map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')));

        const added = [...prowlarrSet].filter(d => !currentSet.has(d));
        const removed = [...currentSet].filter(d => !prowlarrSet.has(d));

        report.indexers[name] = {
            current: data.current,
            prowlarr: data.prowlarr,
            added,
            removed,
            needsUpdate: added.length > 0 || removed.length > 0
        };
    }

    return report;
}

export default {
    getAvailableIndexers,
    getIndexerDomains,
    searchWithCardigann,
    searchMultipleIndexers,
    refreshDefinitions,
    getUpdatedDomains,
    createDomainReport
};
