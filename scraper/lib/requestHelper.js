import UserAgent from 'user-agents';
import axios from 'axios';
import { requestWithBrowser } from './browser.js';

const userAgent = new UserAgent();

export function getRandomUserAgent() {
  return userAgent.random().toString();
}

/**
 * Perform a request with automatic Cloudflare bypass fallback
 * @param {string} url 
 * @param {Object} options Axios options
 */
export async function performRequest(url, options = {}) {
  const defaultHeaders = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    ...options.headers
  };

  try {
    console.log(`[RequestHelper] Fetching ${url}`);
    const response = await axios.get(url, {
      ...options,
      headers: defaultHeaders,
      validateStatus: (status) => status >= 200 && status < 600 // Capture 403/503 for manual handling
    });

    // Check for Cloudflare blocks
    if (isCloudflareBlocked(response)) {
      if (options.skipBrowserFallback) {
        console.warn(`[RequestHelper] Cloudflare block detected for ${url} (Status: ${response.status}). Skipping browser fallback (requested).`);
        // Return a 403-like error so the caller knows it failed due to block
        const error = new Error('Cloudflare blocking request');
        error.code = 'CLOUDFLARE_BLOCKED';
        error.response = response;
        throw error;
      }

      console.warn(`[RequestHelper] Cloudflare block detected for ${url} (Status: ${response.status}). Switching to Serverless Browser...`);
      const html = await requestWithBrowser(url);
      return { data: html, status: 200 }; // Mock an axios-like response structure with valid HTML
    }

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;

  } catch (error) {
    if (error.code === 'CLOUDFLARE_BLOCKED') {
      throw error; // Re-throw intentional block
    }

    // If it's a network error or other fatal error that prevented obtaining a response, try browser as last resort
    // Unless skipped
    if (options.skipBrowserFallback) {
      console.warn(`[RequestHelper] Request failed: ${error.message}. Skipping browser fallback.`);
      throw error;
    }

    console.warn(`[RequestHelper] Request failed: ${error.message}. Retrying with Serverless Browser...`);
    try {
      const html = await requestWithBrowser(url);
      return { data: html, status: 200 };
    } catch (browserError) {
      console.error(`[RequestHelper] Browser fallback also failed for ${url}: ${browserError.message}`);
      throw error;
    }
  }
}

function isCloudflareBlocked(response) {
  if (!response) return false;

  const data = typeof response.data === 'string' ? response.data.toLowerCase() : '';

  // Explicitly blocked statuses
  if (response.status === 403 || response.status === 503) {
    if (data.includes('cloudflare') || data.includes('challenge') || data.includes('just a moment')) {
      return true;
    }
    if (response.headers && response.headers['cf-ray']) {
      return true;
    }
  }

  // 200 OK but actually a challenge page (common with JS challenges)
  if (response.status === 200) {
    if ((data.includes('just a moment') || data.includes('browser verification')) && data.includes('cloudflare')) {
      return true;
    }
    if (data.includes('challenge-platform')) {
      return true;
    }
  }

  return false;
}
