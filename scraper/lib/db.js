import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Initialize Supabase only if credentials exist
const supabase = (supabaseUrl && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey)
    : null;

// Map our local scraper IDs to Prowlarr indexer IDs
// Our scrapers may have different names than Prowlarr uses
const SCRAPER_TO_PROWLARR_MAP = {
    'torrentgalaxy': 'torrentgalaxyclone',  // Prowlarr uses 'torrentgalaxyclone'
    'nyaa': 'nyaasi',                        // We call it nyaa, Prowlarr calls it nyaasi
    'solidtorrents': 'solidtorrents',        // Not in Prowlarr, will return null
    // Others match directly: yts, 1337x, eztv, bitsearch
};

/**
 * Get configuration for a specific scraper
 * @param {string} scraperId - ID of the scraper (e.g., '1337x', 'yts')
 * @returns {Promise<Object|null>} Configuration object or null
 */
export async function getScraperConfig(scraperId) {
    if (!supabase) return null;

    // Map local scraper ID to Prowlarr ID
    const prowlarrId = SCRAPER_TO_PROWLARR_MAP[scraperId] || scraperId;

    try {
        const { data, error } = await supabase
            .from('scraper_configurations')
            .select('config, updated_at')
            .eq('id', prowlarrId)
            .single();

        if (error) {
            // It's normal for config to not exist yet
            if (error.code !== 'PGRST116') {
                console.error(`[DB] Failed to fetch config for ${scraperId}:`, error.message);
            }
            return null;
        }

        // Return the parsed config object (supabase returns the row, we want the config column)
        return data.config;
    } catch (err) {
        console.error(`[DB] Error fetching config for ${scraperId}:`, err.message);
        return null;
    }
}

/**
 * Save configuration for a scraper
 * @param {string} scraperId 
 * @param {Object} configData 
 * @returns {Promise<boolean>} Success status
 */
export async function saveScraperConfig(scraperId, configData) {
    if (!supabase) {
        console.warn('[DB] Supabase credentials missing. Cannot save config.');
        return false;
    }

    try {
        const { error } = await supabase
            .from('scraper_configurations')
            .upsert({
                id: scraperId,
                config: configData,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (error) {
            console.error(`[DB] Failed to save config for ${scraperId}:`, error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error(`[DB] Error saving config for ${scraperId}:`, err.message);
        return false;
    }
}

export default { getScraperConfig, saveScraperConfig };
