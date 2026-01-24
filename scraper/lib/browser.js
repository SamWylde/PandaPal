import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import path from 'path';

// Cache the browser instance to reuse it across warm invocations
let browser = null;

export async function getBrowser() {
    if (browser) {
        return browser;
    }

    try {
        // Vercel / AWS Lambda environment
        const isLambda = process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.VERCEL || process.env.NEXT_PUBLIC_VERCEL_ENV;

        const executablePath = isLambda
            ? await chromium.executablePath()
            : process.env.CHROME_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; // Fallback for local windows dev

        console.log(`[Browser] Launching browser with executable: ${executablePath}`);

        browser = await puppeteer.launch({
            args: isLambda ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: chromium.defaultViewport,
            executablePath: executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        return browser;
    } catch (error) {
        console.error('[Browser] Failed to launch browser:', error);
        throw error;
    }
}

export async function requestWithBrowser(url) {
    let page = null;
    let browserInstance = null;

    try {
        browserInstance = await getBrowser();
        page = await browserInstance.newPage();

        // mimic a real user
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        console.log(`[Browser] Navigating to ${url}...`);

        // Navigation with a generous timeout for Cloudflare to solve
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Check for Cloudflare specific title or content
        const title = await page.title();
        const content = await page.content();

        if (title.includes('Just a moment...') || content.includes('cf-browser-verification') || content.includes('challenge-platform')) {
            console.log('[Browser] Cloudflare challenge detected, waiting...');

            // Wait for standard challenge duration (up to 20s)
            try {
                await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 });
            } catch (e) {
                // Determine if we actually passed or just timed out waiting for a nonexistent nav
                console.log('[Browser] Navigation wait finished (or timed out). Checking content...');
            }

            // Wait a bit more for JS execution
            await new Promise(r => setTimeout(r, 5000));
        }

        // Get final content
        const finalContent = await page.content();
        const finalTitle = await page.title();

        console.log(`[Browser] Finished loading. Title: ${finalTitle}`);

        // Check for 403/404 explicitly if possible, though puppeteer response object has status()
        if (response && response.status() >= 400 && response.status() !== 403) {
            // 403 is often the initial status of a challenge, so we don't treat it as fatal immediately unless we failed to bypass
            // But if it's 404 or 500, we might want to know. 
            // Actually, for Cloudflare, the 403 turns into 200 after bypass. 
            // If we are still seeing Cloudflare content, we failed.
        }

        return finalContent;
    } catch (error) {
        console.error(`[Browser] Error requesting ${url}:`, error.message);
        throw error;
    } finally {
        if (page) {
            await page.close();
        }
        // We do NOT close the browser instance here to reuse it in warm lambdas
        // However, we might want to close it if we are sure we're done, but for now cache it.
        // If memory is an issue, we might change this to close.
    }
}
