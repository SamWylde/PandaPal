/**
 * Cardigann Execution Engine
 *
 * Executes searches using parsed Cardigann definitions.
 * Handles template variables, CSS selectors, and result extraction.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseCardigannYaml, extractDomains, extractSearchConfig } from './parser.js';

export class CardigannEngine {
    constructor(options = {}) {
        this.timeout = options.timeout || 15000;
        this.retries = options.retries || 2;
        this.userAgent = options.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    /**
     * Execute a search using a Cardigann definition
     * @param {string|Object} yamlContentOrParsed - Either raw YAML string or already-parsed definition object
     * @param {string} options.workingDomain - Known working domain from health check (ONLY this domain will be tried)
     */
    async search(yamlContentOrParsed, query, options = {}) {
        // Support both raw YAML strings (from file/sync) and pre-parsed objects (from database)
        const definition = typeof yamlContentOrParsed === 'string'
            ? parseCardigannYaml(yamlContentOrParsed)
            : yamlContentOrParsed;
        const searchConfig = extractSearchConfig(definition);
        const indexerId = definition.id || 'unknown';

        // CRITICAL OPTIMIZATION: If health check provided a working domain, ONLY use that domain.
        // Don't fall back to trying all 20+ domains - that's wasteful and slow.
        // The health check runs hourly and tells us which domain works.
        // If the working domain fails, the whole indexer is likely having issues.
        if (options.workingDomain) {
            const workingDomain = options.workingDomain;
            console.log(`[Cardigann:${indexerId}] Using health check domain: ${workingDomain}`);

            try {
                const results = await this.executeSearch(
                    workingDomain,
                    searchConfig,
                    query,
                    definition,
                    options
                );

                // Return results (even if empty - indexer works but has no content for this query)
                console.log(`[Cardigann:${indexerId}] Found ${results.length} results from ${workingDomain}`);
                return {
                    success: true,
                    results,
                    domain: workingDomain,
                    indexer: indexerId
                };
            } catch (error) {
                // Working domain failed - don't try others, just report failure
                // Health check will update the working domain on next run
                console.log(`[Cardigann:${indexerId}] Health check domain failed: ${error.message}`);
                return {
                    success: false,
                    results: [],
                    errors: [this.formatError(error, workingDomain)],
                    indexer: indexerId
                };
            }
        }

        // FALLBACK MODE: No health check data - try all domains from definition
        // This only happens for indexers that haven't been health-checked yet
        const domains = extractDomains(definition);
        const errors = [];
        const emptyDomains = [];

        console.log(`[Cardigann:${indexerId}] No health data, trying ${domains.length} domains...`);

        for (const domain of domains) {
            try {
                const results = await this.executeSearch(
                    domain,
                    searchConfig,
                    query,
                    definition,
                    options
                );

                if (results.length > 0 || options.acceptEmpty) {
                    console.log(`[Cardigann:${indexerId}] Found ${results.length} results from ${domain}`);
                    return {
                        success: true,
                        results,
                        domain,
                        indexer: indexerId
                    };
                }

                emptyDomains.push(domain);
            } catch (error) {
                const errorInfo = this.formatError(error, domain);
                errors.push(errorInfo);
                console.log(`[Cardigann:${indexerId}] (${domain}): Failed - ${error.message}`);
            }
        }

        // Summarize what happened
        const summary = [];
        if (errors.length > 0) {
            summary.push(`${errors.length} failed (${errors.map(e => e.message).join(', ')})`);
        }
        if (emptyDomains.length > 0) {
            summary.push(`${emptyDomains.length} returned empty results`);
        }

        console.error(`[Cardigann:${indexerId}] All ${domains.length} domains exhausted: ${summary.join('; ') || 'no details'}`);

        return {
            success: false,
            results: [],
            errors,
            emptyDomains,
            indexer: indexerId
        };
    }

    /**
     * Execute search against a single domain
     */
    async executeSearch(domain, searchConfig, query, definition, options) {
        // Clean domain: remove comments (e.g., "http://site.com # comment") and trailing slashes
        let cleanDomain = domain.split('#')[0].trim().replace(/\/+$/, '');
        const baseUrl = cleanDomain.startsWith('http') ? cleanDomain : `https://${cleanDomain}`;

        // Build search URL
        let searchPath = this.resolveSearchPath(searchConfig.paths, query, options);
        // Ensure path starts with / and doesn't have double slashes
        searchPath = '/' + searchPath.replace(/^\/+/, '').replace(/\/+/g, '/');
        const searchUrl = `${baseUrl}${searchPath}`;

        // Build query parameters
        const params = this.buildParams(searchConfig.inputs, query, options);

        // Debug: Log search details to help diagnose empty results
        const paramStr = Object.keys(params).length > 0 ? JSON.stringify(params) : '(no params)';
        console.log(`[Cardigann] Fetching: ${searchUrl} | Query: "${query || '(empty)'}" | Params: ${paramStr}`);

        // Make request with retries
        const response = await this.fetchWithRetry(searchUrl, params, definition);

        // Determine response type and parse
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/json')) {
            return this.parseJsonResponse(response.data, searchConfig, definition);
        } else {
            return this.parseHtmlResponse(response.data, searchConfig, definition, baseUrl);
        }
    }

    /**
     * Resolve the search path from paths array
     */
    resolveSearchPath(paths, query, options) {
        if (!paths || paths.length === 0) {
            return '/search';
        }

        // For now, use the first path
        // TODO: Handle conditional paths based on query type
        let path = paths[0].path || paths[0];

        // Replace template variables
        path = this.replaceTemplateVars(path, query, options);

        return path;
    }

    /**
     * Build request parameters from inputs config
     */
    buildParams(inputs, query, options) {
        const params = {};

        for (const [key, value] of Object.entries(inputs || {})) {
            if (typeof value === 'string' && value.includes('{{')) {
                params[key] = this.replaceTemplateVars(value, query, options);
            } else {
                params[key] = value;
            }
        }

        return params;
    }

    /**
     * Replace Cardigann template variables and evaluate conditionals
     */
    replaceTemplateVars(template, query, options = {}) {
        let result = template;

        // Query variables and their values for both replacement and conditional evaluation
        // CRITICAL: Ensure query has fallback to prevent "undefined" string in URLs
        const safeQuery = query || '';
        const vars = {
            '.Query.Q': safeQuery,
            '.Query.q': safeQuery,
            '.Keywords': safeQuery,
            '.Query.IMDBID': options.imdbId || '',
            '.Query.IMDBIDShort': options.imdbId?.replace('tt', '') || '',
            '.Query.TMDBID': options.tmdbId || '',
            '.Query.Season': options.season || '',
            '.Query.Episode': options.episode || '',
            '.Query.Year': options.year || '',
            '.Today.Year': new Date().getFullYear().toString(),
            // Default config values (normally set by user in Prowlarr/Jackett)
            '.Config.sort': '',
            '.Config.category': '',
            '.Config.cat-id': '',
            '.Config.cat': '',
            '.Config.quality': '',
            '.Config.lang': '',
        };

        // First, handle {{ if .Var }}...{{ else }}...{{ end }} conditionals
        // Pattern matches: {{ if .VarName }}truthy content{{ else }}falsy content{{ end }}
        const ifElsePattern = /\{\{\s*if\s+(\.[^\s}]+)\s*\}\}([\s\S]*?)\{\{\s*else\s*\}\}([\s\S]*?)\{\{\s*end\s*\}\}/gi;
        result = result.replace(ifElsePattern, (match, varName, truthyContent, falsyContent) => {
            const value = vars[varName];
            const isTruthy = value !== undefined && value !== null && value !== '';
            return isTruthy ? truthyContent : falsyContent;
        });

        // Handle {{ if .Var }}...{{ end }} (no else clause)
        const ifOnlyPattern = /\{\{\s*if\s+(\.[^\s}]+)\s*\}\}([\s\S]*?)\{\{\s*end\s*\}\}/gi;
        result = result.replace(ifOnlyPattern, (match, varName, content) => {
            const value = vars[varName];
            const isTruthy = value !== undefined && value !== null && value !== '';
            return isTruthy ? content : '';
        });

        // Then replace simple variables
        for (const [varName, varValue] of Object.entries(vars)) {
            // Handle both {{ .Var }} and {{.Var}} formats
            // Use nullish coalescing to prevent "undefined" string in URLs
            const escapedVarName = varName.replace(/\./g, '\\.');
            result = result.replace(new RegExp(`\\{\\{\\s*${escapedVarName}\\s*\\}\\}`, 'g'), varValue ?? '');
        }

        // CLEANUP: Remove any remaining {{ .Config.* }} or {{ .* }} template tags
        // These are user-configurable settings we don't have values for
        result = result.replace(/\{\{\s*\.Config\.[^}]+\}\}/g, '');
        result = result.replace(/\{\{\s*\.[^}]+\}\}/g, '');

        // Clean up any leftover artifacts (trailing commas, double dashes, etc.)
        result = result.replace(/,+\s*$/, '');  // Trailing commas
        result = result.replace(/--+/g, '-');    // Multiple dashes

        return result;
    }

    /**
     * Fetch with retry logic
     * Only retries on network errors, NOT on HTTP 4xx/5xx errors (which are explicit denials)
     */
    async fetchWithRetry(url, params, definition) {
        let lastError;

        // HTTP status codes that should NOT be retried (explicit denials/blocks)
        const NON_RETRYABLE_STATUS = [403, 401, 429, 451, 503];

        for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
            try {
                const response = await axios.get(url, {
                    params,
                    timeout: this.timeout,
                    headers: {
                        'User-Agent': this.userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    maxRedirects: 5,
                    validateStatus: status => status >= 200 && status < 500
                });

                // Check for non-200 status codes
                if (response.status !== 200) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.isNonRetryable = NON_RETRYABLE_STATUS.includes(response.status);
                    error.status = response.status;
                    throw error;
                }

                // Check for Cloudflare challenge
                const responseText = typeof response.data === 'string' ? response.data.toLowerCase() : '';
                if (responseText.includes('cloudflare') && responseText.includes('challenge')) {
                    const error = new Error('Cloudflare challenge detected');
                    error.isNonRetryable = true; // CF challenges won't succeed with retry
                    throw error;
                }

                return response;
            } catch (error) {
                lastError = error;

                // Don't retry non-retryable errors (403, 429, CF blocks, etc.)
                if (error.isNonRetryable) {
                    throw error;
                }

                // Only retry on network/transient errors
                if (attempt <= this.retries) {
                    const delay = 1000 * Math.pow(2, attempt - 1);
                    console.log(`[Cardigann] Attempt ${attempt}/${this.retries + 1} failed, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Parse JSON API response
     */
    parseJsonResponse(data, searchConfig, definition) {
        const results = [];
        const fields = searchConfig.fields || {};

        // Handle common API structures
        let items = [];

        if (Array.isArray(data)) {
            items = data;
        } else if (data.data?.movies) {
            // YTS format
            items = data.data.movies.flatMap(m => m.torrents?.map(t => ({ ...t, movie: m })) || []);
        } else if (data.data?.torrents) {
            items = data.data.torrents;
        } else if (data.torrents) {
            items = data.torrents;
        } else if (data.results) {
            items = data.results;
        }

        for (const item of items.slice(0, 50)) {
            const torrent = this.extractTorrentFromJson(item, fields, definition);
            if (torrent && torrent.infoHash) {
                results.push(torrent);
            }
        }

        return results;
    }

    /**
     * Parse HTML response using CSS selectors
     */
    parseHtmlResponse(html, searchConfig, definition, baseUrl) {
        const results = [];
        const $ = cheerio.load(html);
        const rowSelector = searchConfig.rowSelector || searchConfig.rows?.selector;
        const fields = searchConfig.fields || {};

        if (!rowSelector) {
            console.warn('[Cardigann] No row selector defined, cannot parse HTML');
            return results;
        }

        const rows = $(rowSelector);
        console.log(`[Cardigann] Found ${rows.length} rows with selector: ${rowSelector}`);

        rows.slice(0, 50).each((i, el) => {
            const torrent = this.extractTorrentFromHtml($, el, fields, baseUrl, definition);
            if (torrent && (torrent.infoHash || torrent.magnetUrl)) {
                results.push(torrent);
            }
        });

        return results;
    }

    /**
     * Extract torrent data from JSON item
     */
    extractTorrentFromJson(item, fields, definition) {
        // Handle various JSON structures
        const torrent = {
            provider: definition.id || 'cardigann',
            uploadDate: new Date()
        };

        // Common field mappings
        torrent.title = item.title || item.name || item.filename;
        torrent.infoHash = (item.hash || item.info_hash || item.infohash)?.toLowerCase();
        torrent.size = item.size || item.size_bytes || item.filesize;
        torrent.seeders = parseInt(item.seeders || item.seeds || item.se || 0);
        torrent.magnetUrl = item.magnet || item.magnet_url || item.magnetUrl;

        // Build magnet if we have hash but no magnet
        if (torrent.infoHash && !torrent.magnetUrl) {
            torrent.magnetUrl = `magnet:?xt=urn:btih:${torrent.infoHash}`;
        }

        // Extract hash from magnet if we have magnet but no hash
        if (torrent.magnetUrl && !torrent.infoHash) {
            const match = torrent.magnetUrl.match(/btih:([a-fA-F0-9]+)/i);
            if (match) torrent.infoHash = match[1].toLowerCase();
        }

        // Resolution detection
        torrent.resolution = this.detectResolution(torrent.title);

        return torrent;
    }

    /**
     * Extract torrent data from HTML row
     */
    extractTorrentFromHtml($, el, fields, baseUrl, definition) {
        const torrent = {
            provider: definition.id || 'cardigann',
            uploadDate: new Date()
        };

        const $el = $(el);

        // Extract using field selectors
        for (const [fieldName, fieldConfig] of Object.entries(fields)) {
            const selector = fieldConfig.selector;
            const attribute = fieldConfig.attribute;

            if (!selector) continue;

            let value;
            const $field = $el.find(selector);

            if (attribute === 'href') {
                value = $field.attr('href');
            } else if (attribute) {
                value = $field.attr(attribute);
            } else {
                value = $field.text().trim();
            }

            if (value) {
                switch (fieldName) {
                    case 'title':
                        torrent.title = value;
                        break;
                    case 'download':
                    case 'magnet':
                        if (value.startsWith('magnet:')) {
                            torrent.magnetUrl = value;
                        } else if (value.startsWith('/') || value.startsWith('http')) {
                            torrent.downloadUrl = value.startsWith('/') ? baseUrl + value : value;
                        }
                        break;
                    case 'infohash':
                        torrent.infoHash = value.toLowerCase();
                        break;
                    case 'seeders':
                        torrent.seeders = parseInt(value.replace(/,/g, '')) || 0;
                        break;
                    case 'size':
                        torrent.size = this.parseSize(value);
                        break;
                }
            }
        }

        // Fallback: Try common selectors if fields didn't work
        if (!torrent.title) {
            torrent.title = $el.find('a.txlight, td.name a, a[title]').first().text().trim() ||
                $el.find('a').first().text().trim();
        }

        if (!torrent.magnetUrl) {
            const magnetLink = $el.find('a[href^="magnet:"]').attr('href');
            if (magnetLink) torrent.magnetUrl = magnetLink;
        }

        // Extract hash from magnet
        if (torrent.magnetUrl && !torrent.infoHash) {
            const match = torrent.magnetUrl.match(/btih:([a-fA-F0-9]+)/i);
            if (match) torrent.infoHash = match[1].toLowerCase();
        }

        // Resolution detection
        if (torrent.title) {
            torrent.resolution = this.detectResolution(torrent.title);
        }

        return torrent;
    }

    /**
     * Detect resolution from title
     */
    detectResolution(title) {
        if (!title) return null;
        const t = title.toLowerCase();
        if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4k';
        if (t.includes('1080p') || t.includes('1080i')) return '1080p';
        if (t.includes('720p')) return '720p';
        if (t.includes('480p') || t.includes('sd')) return '480p';
        return null;
    }

    /**
     * Parse size string to bytes
     */
    parseSize(sizeStr) {
        if (!sizeStr || typeof sizeStr === 'number') return sizeStr || 0;

        const match = sizeStr.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
        if (!match) return 0;

        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();

        const multipliers = {
            'TB': 1024 * 1024 * 1024 * 1024,
            'GB': 1024 * 1024 * 1024,
            'MB': 1024 * 1024,
            'KB': 1024,
            'B': 1
        };

        return Math.floor(value * (multipliers[unit] || 1));
    }

    /**
     * Format error for logging
     */
    formatError(error, domain) {
        const details = {
            domain,
            message: error.message,
            code: error.code || (error.status ? `HTTP_${error.status}` : 'UNKNOWN')
        };

        // Include HTTP status if available
        if (error.status) {
            details.status = error.status;
        }

        if (error.response) {
            details.status = error.response.status;
            details.statusText = error.response.statusText;
        }

        // Mark if this was a non-retryable error (403, CF block, etc.)
        if (error.isNonRetryable) {
            details.nonRetryable = true;
        }

        return details;
    }
}

export default CardigannEngine;
