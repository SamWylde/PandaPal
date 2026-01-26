/**
 * FlareSolverr Service
 *
 * Uses external FlareSolverr instance to bypass Cloudflare protection.
 * FlareSolverr runs a headless browser that can solve Turnstile/JS challenges.
 *
 * API Documentation: https://github.com/FlareSolverr/FlareSolverr
 */

import axios from 'axios';

// FlareSolverr endpoint (user can set via environment variable)
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-render-4v1l.onrender.com/v1';

// Default timeout for challenge solving (FlareSolverr can take a while on cold starts)
const DEFAULT_TIMEOUT_MS = 60000;

// Mutex to ensure only one request at a time (user's instance handles 1 request at a time)
let requestQueue = Promise.resolve();

/**
 * Queue a request to FlareSolverr (ensures sequential processing)
 * @param {Function} fn - Async function to execute
 * @returns {Promise} - Result of the function
 */
async function queueRequest(fn) {
    const result = requestQueue.then(fn).catch(fn);
    requestQueue = result.catch(() => {}); // Prevent unhandled rejection
    return result;
}

/**
 * Check if FlareSolverr is available
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
    if (!FLARESOLVERR_URL) {
        return false;
    }

    try {
        // FlareSolverr doesn't have a health endpoint, but we can check if it responds
        const response = await axios.post(FLARESOLVERR_URL, {
            cmd: 'sessions.list'
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        return response.data?.status === 'ok';
    } catch (error) {
        console.log(`[FlareSolverr] Service not available: ${error.message}`);
        return false;
    }
}

/**
 * Solve Cloudflare challenge using FlareSolverr
 *
 * @param {string} url - The URL to solve CF challenge for
 * @param {object} options - Options
 * @param {number} options.timeout - Timeout in ms (default 60000)
 * @param {boolean} options.returnOnlyCookies - Only return cookies, not HTML (default true)
 * @returns {Promise<{success: boolean, cookies?: array, userAgent?: string, html?: string, error?: string}>}
 */
export async function solveCFChallenge(url, options = {}) {
    const {
        timeout = DEFAULT_TIMEOUT_MS,
        returnOnlyCookies = true
    } = options;

    if (!FLARESOLVERR_URL) {
        return {
            success: false,
            error: 'FlareSolverr URL not configured'
        };
    }

    console.log(`[FlareSolverr] Solving challenge for ${url} (timeout: ${timeout}ms)`);

    // Queue request to ensure sequential processing
    return queueRequest(async () => {
        try {
            const startTime = Date.now();

            const response = await axios.post(FLARESOLVERR_URL, {
                cmd: 'request.get',
                url: url,
                maxTimeout: timeout,
                returnOnlyCookies: returnOnlyCookies
            }, {
                timeout: timeout + 10000, // Add buffer for network latency
                headers: { 'Content-Type': 'application/json' }
            });

            const elapsed = Date.now() - startTime;

            if (response.data?.status === 'ok') {
                const solution = response.data.solution;

                console.log(`[FlareSolverr] Successfully solved in ${elapsed}ms`);

                // Convert FlareSolverr cookie format to Puppeteer-compatible format
                const cookies = (solution.cookies || []).map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    expires: c.expiry ? c.expiry : undefined,
                    httpOnly: c.httpOnly || false,
                    secure: c.secure || false,
                    sameSite: c.sameSite || 'Lax'
                }));

                return {
                    success: true,
                    cookies: cookies,
                    userAgent: solution.userAgent,
                    html: solution.response,
                    finalUrl: solution.url,
                    status: solution.status,
                    fromCache: false
                };
            } else {
                const errorMsg = response.data?.message || 'Unknown FlareSolverr error';
                console.log(`[FlareSolverr] Failed: ${errorMsg}`);

                return {
                    success: false,
                    error: errorMsg
                };
            }
        } catch (error) {
            console.error(`[FlareSolverr] Request failed: ${error.message}`);

            // Parse error details if available
            let errorMsg = error.message;
            if (error.response?.data?.message) {
                errorMsg = error.response.data.message;
            }

            return {
                success: false,
                error: errorMsg
            };
        }
    });
}

/**
 * Make a GET request through FlareSolverr (bypassing CF protection)
 *
 * @param {string} url - URL to request
 * @param {object} options - Options
 * @param {number} options.timeout - Timeout in ms
 * @returns {Promise<{success: boolean, html?: string, cookies?: array, userAgent?: string, error?: string}>}
 */
export async function fetchWithCFBypass(url, options = {}) {
    return solveCFChallenge(url, {
        ...options,
        returnOnlyCookies: false
    });
}

/**
 * Create a persistent FlareSolverr session
 * Sessions retain cookies and browser state between requests
 *
 * @param {string} sessionId - Optional custom session ID
 * @returns {Promise<{success: boolean, sessionId?: string, error?: string}>}
 */
export async function createSession(sessionId = null) {
    if (!FLARESOLVERR_URL) {
        return { success: false, error: 'FlareSolverr URL not configured' };
    }

    return queueRequest(async () => {
        try {
            const payload = { cmd: 'sessions.create' };
            if (sessionId) {
                payload.session = sessionId;
            }

            const response = await axios.post(FLARESOLVERR_URL, payload, {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data?.status === 'ok') {
                console.log(`[FlareSolverr] Created session: ${response.data.session}`);
                return {
                    success: true,
                    sessionId: response.data.session
                };
            }

            return {
                success: false,
                error: response.data?.message || 'Failed to create session'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    });
}

/**
 * Destroy a FlareSolverr session
 *
 * @param {string} sessionId - Session ID to destroy
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function destroySession(sessionId) {
    if (!FLARESOLVERR_URL) {
        return { success: false, error: 'FlareSolverr URL not configured' };
    }

    return queueRequest(async () => {
        try {
            const response = await axios.post(FLARESOLVERR_URL, {
                cmd: 'sessions.destroy',
                session: sessionId
            }, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data?.status === 'ok') {
                console.log(`[FlareSolverr] Destroyed session: ${sessionId}`);
                return { success: true };
            }

            return {
                success: false,
                error: response.data?.message || 'Failed to destroy session'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    });
}

/**
 * List active FlareSolverr sessions
 *
 * @returns {Promise<{success: boolean, sessions?: string[], error?: string}>}
 */
export async function listSessions() {
    if (!FLARESOLVERR_URL) {
        return { success: false, error: 'FlareSolverr URL not configured' };
    }

    try {
        const response = await axios.post(FLARESOLVERR_URL, {
            cmd: 'sessions.list'
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok') {
            return {
                success: true,
                sessions: response.data.sessions || []
            };
        }

        return {
            success: false,
            error: response.data?.message || 'Failed to list sessions'
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Solve challenge using an existing session (faster for repeated requests to same domain)
 *
 * @param {string} url - URL to request
 * @param {string} sessionId - FlareSolverr session ID
 * @param {object} options - Options
 * @returns {Promise<object>} - Same as solveCFChallenge
 */
export async function solveWithSession(url, sessionId, options = {}) {
    const { timeout = DEFAULT_TIMEOUT_MS, returnOnlyCookies = true } = options;

    if (!FLARESOLVERR_URL) {
        return { success: false, error: 'FlareSolverr URL not configured' };
    }

    return queueRequest(async () => {
        try {
            const response = await axios.post(FLARESOLVERR_URL, {
                cmd: 'request.get',
                url: url,
                session: sessionId,
                maxTimeout: timeout,
                returnOnlyCookies: returnOnlyCookies
            }, {
                timeout: timeout + 10000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data?.status === 'ok') {
                const solution = response.data.solution;

                const cookies = (solution.cookies || []).map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    expires: c.expiry ? c.expiry : undefined,
                    httpOnly: c.httpOnly || false,
                    secure: c.secure || false
                }));

                return {
                    success: true,
                    cookies: cookies,
                    userAgent: solution.userAgent,
                    html: solution.response,
                    finalUrl: solution.url,
                    status: solution.status
                };
            }

            return {
                success: false,
                error: response.data?.message || 'Unknown error'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    });
}

export default {
    isAvailable,
    solveCFChallenge,
    fetchWithCFBypass,
    createSession,
    destroySession,
    listSessions,
    solveWithSession
};
