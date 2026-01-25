/**
 * CloudFlare Solver Service
 *
 * Uses Puppeteer with stealth plugin to solve CF challenges.
 * Stores solved cookies in Supabase for reuse.
 *
 * Based on Prowlarr's FlareSolverr integration pattern.
 */

import { supabase } from './db.js';

// Dynamic import for puppeteer to handle stealth plugin issues
let puppeteer;
let stealthEnabled = false;
let chromiumExecutablePath = null;
let initPromise = null;

async function getPuppeteer() {
    if (puppeteer && chromiumExecutablePath) return { puppeteer, executablePath: chromiumExecutablePath };

    // Singleton lock to prevent parallel extraction race conditions (ETXTBSY on Vercel)
    if (!initPromise) {
        initPromise = (async () => {
            try {
                // Try to use puppeteer-extra with stealth
                const puppeteerExtra = await import('puppeteer-extra');
                const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
                const chromium = await import('@sparticuz/chromium');

                // Configuration for serverless
                // Use 'new' headless mode - harder for Cloudflare to detect than 'shell'
                chromium.default.setHeadlessMode = 'new';
                chromium.default.setGraphicsMode = false;

                // Ensure stealth evasion modules are available in the bundle (Vercel fix)
                // We import these specifically because the bundler misses dynamic requires inside the plugin
                // Wrapped in try/catch to ensure we don't crash if Vercel treeshakes them differently
                try {
                    await import('puppeteer-extra-plugin-stealth/evasions/chrome.app/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/chrome.csi/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/chrome.runtime/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/console.debug/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/defaultArgs/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/media.codecs/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.permissions/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.plugins/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.vendor/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/navigator.webdriver/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/sourceurl/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/webgl.vendor/index.js');
                    await import('puppeteer-extra-plugin-stealth/evasions/window.outerdimensions/index.js');
                } catch (importErr) {
                    console.warn('[CFSolver] Stealth evasions could not be pre-loaded, continuing anyway...');
                }

                // Initialize plugins
                puppeteer = puppeteerExtra.default;
                puppeteer.use(StealthPlugin.default());

                // Explicitly use UserPreferences & its dependencies to satisfy checks
                try {
                    const UserDataDirPlugin = await import('puppeteer-extra-plugin-user-data-dir');
                    puppeteer.use(UserDataDirPlugin.default());

                    const UserPreferencesPlugin = await import('puppeteer-extra-plugin-user-preferences');
                    puppeteer.use(UserPreferencesPlugin.default());
                } catch (prefErr) {
                    console.warn('[CFSolver] Plugin import warning:', prefErr.message);
                }

                stealthEnabled = true;

                // CRITICAL: Get executable path ONCE here to prevent race condition during extraction
                chromiumExecutablePath = await chromium.default.executablePath();

                console.log('[CFSolver] Loaded puppeteer-extra with stealth plugin');
            } catch (err) {
                // Fall back to puppeteer-core without stealth
                console.warn(`[CFSolver] Stealth plugin init failed: ${err.message}`);
                console.warn('[CFSolver] Falling back to puppeteer-core (Manual Stealth Mode)');

                const puppeteerCore = await import('puppeteer-core');
                const chromium = await import('@sparticuz/chromium');
                const UserAgent = await import('user-agents');

                puppeteer = puppeteerCore.default;
                chromiumExecutablePath = await chromium.default.executablePath(); // SINGLETON for fallback too
                stealthEnabled = false;

                // Configure manual stealth args
                const minimalArgs = [
                    ...chromium.default.args,
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ];

                // Override launch to inject manual stealth
                const originalLaunch = puppeteer.launch;
                puppeteer.launch = async (options) => {
                    const browser = await originalLaunch.call(puppeteer, {
                        ...options,
                        args: minimalArgs,
                        ignoreDefaultArgs: ['--enable-automation']
                    });

                    // Inject stealth scripts into new pages
                    const originalNewPage = browser.newPage;
                    browser.newPage = async () => {
                        const page = await originalNewPage.call(browser);
                        const ua = new UserAgent.default().toString();
                        await page.setUserAgent(ua);
                        await page.evaluateOnNewDocument(() => {
                            Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        });
                        return page;
                    };
                    return browser;
                };
            }
        })();
    }

    await initPromise;
    return { puppeteer, executablePath: chromiumExecutablePath };
}

// Supabase client (imported from db.js)

// CF challenge detection patterns (from Prowlarr)
const CF_CHALLENGE_TITLES = [
    'just a moment...',
    'attention required! | cloudflare',
    'access denied',
    'ddos-guard'
];

const CF_CHALLENGE_SELECTORS = [
    '#cf-challenge-running',
    '#cf-please-wait',
    '#challenge-spinner',
    '#turnstile-wrapper',
    '.cf-error-title',
    '#trk_jschal_js'
];

// Default cookie expiry (30 minutes - CF cookies typically last 15min-24h)
const DEFAULT_COOKIE_TTL_MS = 30 * 60 * 1000;

/**
 * Extract domain from URL
 */
function extractDomain(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch {
        return url;
    }
}

/**
 * Get cached CF session from Supabase
 */
export async function getCachedSession(domain) {
    if (!supabase) {
        console.log('[CFSolver] No Supabase client, skipping cache');
        return null;
    }

    try {
        const { data, error } = await supabase
            .from('cf_sessions')
            .select('*')
            .eq('domain', domain)
            .gt('expires_at', new Date().toISOString())
            .single();

        if (error || !data) {
            return null;
        }

        console.log(`[CFSolver] Found cached session for ${domain} (expires: ${data.expires_at})`);
        return {
            cookies: data.cookies,
            userAgent: data.user_agent
        };
    } catch (e) {
        console.log(`[CFSolver] Cache lookup failed: ${e.message}`);
        return null;
    }
}

/**
 * Store solved CF session in Supabase
 */
async function storeCachedSession(domain, cookies, userAgent, ttlMs = DEFAULT_COOKIE_TTL_MS) {
    if (!supabase) {
        return;
    }

    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    try {
        const { error } = await supabase
            .from('cf_sessions')
            .upsert({
                domain,
                cookies,
                user_agent: userAgent,
                expires_at: expiresAt,
                last_success: new Date().toISOString()
            }, { onConflict: 'domain' });

        if (error) {
            console.log(`[CFSolver] Failed to cache session: ${error.message}`);
        } else {
            console.log(`[CFSolver] Cached session for ${domain} (expires: ${expiresAt})`);
        }
    } catch (e) {
        console.log(`[CFSolver] Cache store failed: ${e.message}`);
    }
}

/**
 * Check if page has CF challenge
 */
async function hasCFChallenge(page) {
    try {
        // Check title
        const title = await page.title();
        if (CF_CHALLENGE_TITLES.some(t => title.toLowerCase().includes(t))) {
            return true;
        }

        // Check for challenge elements
        for (const selector of CF_CHALLENGE_SELECTORS) {
            const element = await page.$(selector);
            if (element) {
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Wait for CF challenge to be solved
 */
async function waitForChallengeSolved(page, timeoutMs = 60000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        // Check if challenge is still present
        if (!(await hasCFChallenge(page))) {
            // Wait 7-8 seconds after challenge disappears (per Cloudflare bypass best practices)
            // This ensures cf_clearance cookie is fully set before we extract cookies
            console.log('[CFSolver] Challenge disappeared, waiting 8s for cookies to stabilize...');
            await new Promise(r => setTimeout(r, 8000));

            // Double-check
            if (!(await hasCFChallenge(page))) {
                console.log('[CFSolver] Challenge appears to be solved');
                return true;
            }
        }

        // Wait before checking again
        await new Promise(r => setTimeout(r, 1000));
    }

    return false;
}

/**
 * Solve CloudFlare challenge for a URL
 *
 * @param {string} url - The URL to solve CF challenge for
 * @param {object} options - Options
 * @param {number} options.timeout - Timeout in ms (default 60000)
 * @param {boolean} options.useCache - Whether to check cache first (default true)
 * @returns {Promise<{success: boolean, cookies?: array, userAgent?: string, error?: string}>}
 */
export async function solveCFChallenge(url, options = {}) {
    // MAX 25s timeout - CF bypass rarely works on serverless anyway
    const { timeout = 25000, useCache = true } = options;
    const actualTimeout = Math.min(timeout, 25000); // Cap at 25s
    const startTime = Date.now();
    console.log(`[CFSolver] Solving for ${url} (timeout: ${actualTimeout}ms)`);
    const domain = extractDomain(url);

    console.log(`[CFSolver] Attempting to solve CF challenge for ${domain}`);

    // Check cache first
    if (useCache) {
        const cached = await getCachedSession(domain);
        if (cached) {
            console.log(`[CFSolver] Using cached session for ${domain}`);
            return {
                success: true,
                cookies: cached.cookies,
                userAgent: cached.userAgent,
                fromCache: true
            };
        }
    }

    // Need to solve with browser
    let browser = null;
    let page = null;  // Track page for explicit cleanup

    try {
        // Get puppeteer instance (with or without stealth)
        // Returns singleton { puppeteer, executablePath }
        const { puppeteer: pptr, executablePath } = await getPuppeteer();

        // Import chromium dynamically (for serverless args)
        const chromium = await import('@sparticuz/chromium');

        console.log(`[CFSolver] Launching browser... (stealth: ${stealthEnabled})`);

        // Randomize viewport for fingerprint diversity (CF bypass best practice)
        const viewports = [
            { width: 1920, height: 1080 },
            { width: 1366, height: 768 },
            { width: 1536, height: 864 },
            { width: 1440, height: 900 },
            { width: 1280, height: 720 }
        ];
        const viewport = viewports[Math.floor(Math.random() * viewports.length)];

        browser = await pptr.launch({
            args: [
                ...chromium.default.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            defaultViewport: viewport,
            executablePath: executablePath, // Use cached path
            headless: 'new', // Use new headless mode (harder for CF to detect than 'shell')
            timeout: 30000
        });

        page = await browser.newPage();

        // Set a realistic user agent
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        await page.setUserAgent(userAgent);

        // Set extra headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        console.log(`[CFSolver] Navigating to ${url}...`);

        // Navigate to the page
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Check if we hit a CF challenge
        const hasChallenge = await hasCFChallenge(page);

        if (hasChallenge) {
            console.log('[CFSolver] CF challenge detected, waiting for solution...');

            // Calculate remaining time, with minimum of 10s for challenge solving
            const elapsedMs = Date.now() - startTime;
            const remainingMs = Math.max(10000, actualTimeout - elapsedMs);
            console.log(`[CFSolver] Challenge timeout: ${remainingMs}ms (elapsed: ${elapsedMs}ms)`);

            const solved = await waitForChallengeSolved(page, remainingMs);

            if (!solved) {
                throw new Error('Challenge timeout - could not solve within time limit');
            }
        } else {
            console.log('[CFSolver] No CF challenge detected on page');
        }

        // Get cookies
        const cookies = await page.cookies();

        // Filter to relevant CF cookies
        const cfCookies = cookies.filter(c =>
            c.name.startsWith('cf_') ||
            c.name === '__cf_bm' ||
            c.name === 'cf_clearance' ||
            c.domain.includes(domain)
        );

        if (cfCookies.length === 0) {
            // Include all cookies for this domain
            const domainCookies = cookies.filter(c => c.domain.includes(domain));
            console.log(`[CFSolver] No CF-specific cookies, using ${domainCookies.length} domain cookies`);

            await storeCachedSession(domain, domainCookies, userAgent);

            return {
                success: true,
                cookies: domainCookies,
                userAgent,
                fromCache: false
            };
        }

        console.log(`[CFSolver] Got ${cfCookies.length} CF cookies`);

        // Find cf_clearance expiry to set appropriate TTL
        const clearanceCookie = cfCookies.find(c => c.name === 'cf_clearance');
        let ttlMs = DEFAULT_COOKIE_TTL_MS;
        if (clearanceCookie && clearanceCookie.expires) {
            ttlMs = Math.max(0, (clearanceCookie.expires * 1000) - Date.now() - 60000); // 1 min buffer
        }

        // Store in cache
        await storeCachedSession(domain, cfCookies, userAgent, ttlMs);

        return {
            success: true,
            cookies: cfCookies,
            userAgent,
            fromCache: false
        };

    } catch (error) {
        console.error(`[CFSolver] Failed to solve challenge: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    } finally {
        // Hospital-grade cleanup: explicitly close page before browser
        if (page) {
            try {
                await page.close();
            } catch (e) {
                console.log(`[CFSolver] Error closing page: ${e.message}`);
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.log(`[CFSolver] Error closing browser: ${e.message}`);
            }
        }
    }
}

/**
 * Make a request using solved CF cookies
 *
 * @param {string} url - URL to request
 * @param {object} session - Session object with cookies and userAgent
 * @param {object} axiosInstance - Axios instance to use
 * @returns {Promise<object>} - Axios response
 */
export async function requestWithCFSession(url, session, axiosInstance) {
    const { cookies, userAgent } = session;

    // Convert cookies to header format
    const cookieHeader = cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    return axiosInstance.get(url, {
        headers: {
            'User-Agent': userAgent,
            'Cookie': cookieHeader,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 30000,
        validateStatus: (status) => status < 500
    });
}

/**
 * Clear expired sessions from Supabase
 */
export async function cleanupExpiredSessions() {
    if (!supabase) return;

    try {
        const { error, count } = await supabase
            .from('cf_sessions')
            .delete()
            .lt('expires_at', new Date().toISOString());

        if (!error) {
            console.log(`[CFSolver] Cleaned up ${count || 0} expired sessions`);
        }
    } catch (e) {
        console.log(`[CFSolver] Cleanup failed: ${e.message}`);
    }
}

export default {
    solveCFChallenge,
    getCachedSession,
    requestWithCFSession,
    cleanupExpiredSessions
};
