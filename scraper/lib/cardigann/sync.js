/**
 * Cardigann Definition Sync
 *
 * Downloads and caches YAML indexer definitions from Prowlarr's repo.
 * Updates weekly to keep domains and selectors current.
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prowlarr Indexers repo - updated daily via GitHub Actions
const PROWLARR_API_BASE = 'https://api.github.com/repos/Prowlarr/Indexers/contents/definitions/v11';
const PROWLARR_RAW_BASE = 'https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11';

// Local cache directory
// On Vercel (read-only fs), use /tmp
const isLambda = process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.VERCEL || process.env.NEXT_PUBLIC_VERCEL_ENV;
const CACHE_DIR = isLambda
    ? path.join(os.tmpdir(), 'cardigann', 'definitions')
    : path.join(__dirname, 'definitions');

const METADATA_FILE = path.join(CACHE_DIR, '_metadata.json');

// Public indexers we're interested in (no login required)
// Names must match EXACT file names in Prowlarr/Indexers repo (without .yml)
const PUBLIC_INDEXERS = [
    '0magnet',
    '1337x',
    '52bt',
    'acgrip',
    'anisource',
    'arabtorrents-com',
    'bangumi-moe',
    'bigfangroup',
    'bitru',
    'bitsearch',
    'blueroms',
    'btdirectory',
    'btetree',
    'btstate',
    'byrutor',
    'catorrent',
    'cpasbienclone',
    'crackingpatching',
    'damagnet',
    'dmhy',
    'ebookbay',
    'ehentai',
    'elitetorrent-wf',
    'extratorrent-st',
    'eztv',
    'filemood',
    'freejavtorrent',
    'frozenlayer',
    'gamestorrents',
    'gtorrentpro',
    'ilcorsaronero',
    'internetarchive',
    'isohunt2',
    'kickasstorrents-to',
    'kickasstorrents-ws',
    'limetorrents',
    'linuxtracker',
    'mactorrentsdownload',
    'magnetcat',
    'magnetdownload',
    'magnetz',
    'megapeer',
    'mikan',
    'mixtapetorrent',
    'moviesdvdr',
    'mypornclub',
    'nekobt',
    'newstudio',
    'nipponsei',
    'noname-club',
    'nortorrent',
    'nyaasi',
    'onejav',
    'opensharing',
    'pctorrent',
    'piratesparadise',
    'plugintorrent',
    'pornrips',
    'postman',
    'rintornet',
    'rutor',
    'rutracker-ru',
    'sexypics',
    'shanaproject',
    'showrss',
    'skidrowrepack',
    'sosulki',
    'sukebeinyaasi',
    'thepiratebay',
    'tokyotosho',
    'torrent-pirat',
    'torrent9',
    'torrentby',
    'torrentcore',
    'torrentdownload',
    'torrentdownloads',
    'torrentgalaxyclone',
    'torrentkitty',
    'torrentoyunindir',
    'torrentproject2',
    'torrentqq',
    'torrentsome',
    'torrenttip',
    'traht',
    'u3c3',
    'uindex',
    'uztracker',
    'vsthouse',
    'vstorrent',
    'vsttorrents',
    'world-torrent',
    'xxxclub',
    'xxxtor',
    'yts',
    'zktorrent'
];

export class DefinitionSync {
    constructor(options = {}) {
        this.cacheDir = options.cacheDir || CACHE_DIR;
        this.maxAgeHours = options.maxAgeHours || 168; // 1 week
        this.indexerFilter = options.indexers || PUBLIC_INDEXERS;
    }

    /**
     * Initialize the sync - create cache dir if needed
     */
    async init() {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
            console.log(`[Cardigann] Cache directory ready: ${this.cacheDir}`);
        } catch (error) {
            console.error(`[Cardigann] Failed to create cache dir: ${error.message}`);
            // If we can't create cache dir, we should arguably throw or handle it, 
            // but for now logging is consistent with existing code.
        }
    }

    /**
     * Check if definitions need updating
     */
    async needsUpdate() {
        try {
            const metadata = await this.getMetadata();
            if (!metadata.lastSync) return true;

            const lastSync = new Date(metadata.lastSync);
            const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

            console.log(`[Cardigann] Last sync: ${lastSync.toISOString()} (${Math.floor(hoursSinceSync)}h ago)`);
            return hoursSinceSync > this.maxAgeHours;
        } catch {
            return true;
        }
    }

    /**
     * Get cached metadata
     */
    async getMetadata() {
        try {
            const data = await fs.readFile(METADATA_FILE, 'utf-8');
            return JSON.parse(data);
        } catch {
            return { lastSync: null, indexers: {} };
        }
    }

    /**
     * Save metadata
     */
    async saveMetadata(metadata) {
        await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
    }

    /**
     * Sync definitions from Prowlarr repo
     */
    async sync(force = false) {
        if (!force && !(await this.needsUpdate())) {
            console.log('[Cardigann] Definitions are up to date');
            return await this.getMetadata();
        }

        console.log('[Cardigann] Starting definition sync from Prowlarr/Indexers...');
        await this.init();

        const metadata = {
            lastSync: new Date().toISOString(),
            source: 'https://github.com/Prowlarr/Indexers',
            version: 'v11',
            indexers: {}
        };

        let successCount = 0;
        let failCount = 0;

        for (const indexerId of this.indexerFilter) {
            try {
                const definition = await this.fetchDefinition(indexerId);
                if (definition) {
                    // Save definition to cache
                    const filePath = path.join(this.cacheDir, `${indexerId}.yml`);
                    await fs.writeFile(filePath, definition);

                    // Extract key info for metadata
                    const info = this.extractBasicInfo(definition);
                    metadata.indexers[indexerId] = info;

                    console.log(`[Cardigann] ✓ Synced: ${indexerId} (${info.links?.length || 0} domains)`);
                    successCount++;
                }
            } catch (error) {
                console.log(`[Cardigann] ✗ Failed: ${indexerId} - ${error.message}`);
                failCount++;
            }

            // Rate limiting - don't hammer GitHub
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        await this.saveMetadata(metadata);
        console.log(`[Cardigann] Sync complete: ${successCount} synced, ${failCount} failed`);

        return metadata;
    }

    /**
     * Fetch a single definition from Prowlarr
     */
    async fetchDefinition(indexerId) {
        const url = `${PROWLARR_RAW_BASE}/${indexerId}.yml`;

        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'PandaPal/1.0 (Stremio Addon)',
                'Accept': 'text/plain'
            },
            validateStatus: status => status === 200
        });

        return response.data;
    }

    /**
     * Extract basic info from YAML without full parsing
     * (Quick extraction using regex for metadata purposes)
     */
    extractBasicInfo(yamlContent) {
        const info = {
            links: [],
            type: 'public',
            language: 'en-US'
        };

        // Extract links array
        const linksMatch = yamlContent.match(/links:\s*\n((?:\s+-\s+.+\n?)+)/);
        if (linksMatch) {
            const linkLines = linksMatch[1].match(/-\s+(.+)/g) || [];
            info.links = linkLines.map(l => l.replace(/^-\s+/, '').trim());
        }

        // Extract type
        const typeMatch = yamlContent.match(/type:\s+(\w+)/);
        if (typeMatch) {
            info.type = typeMatch[1];
        }

        // Extract language
        const langMatch = yamlContent.match(/language:\s+([\w-]+)/);
        if (langMatch) {
            info.language = langMatch[1];
        }

        // Extract name
        const nameMatch = yamlContent.match(/name:\s+(.+)/);
        if (nameMatch) {
            info.name = nameMatch[1].trim();
        }

        return info;
    }

    /**
     * Get cached definition
     */
    async getDefinition(indexerId) {
        const filePath = path.join(this.cacheDir, `${indexerId}.yml`);
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Get all cached definitions
     */
    async getAllDefinitions() {
        const definitions = {};
        for (const indexerId of this.indexerFilter) {
            const def = await this.getDefinition(indexerId);
            if (def) {
                definitions[indexerId] = def;
            }
        }
        return definitions;
    }

    /**
     * Get current domains for an indexer
     */
    async getDomains(indexerId) {
        const metadata = await this.getMetadata();
        return metadata.indexers[indexerId]?.links || [];
    }
}

export default DefinitionSync;
