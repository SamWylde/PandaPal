import { manifest as torrentioManifest } from '../scraper/lib/manifest.js';
import { parseConfiguration } from '../scraper/lib/configuration.js';
import axios from 'axios';

export default async function (req, res) {
    const configs = req.query.configs || '';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = `${protocol}://${req.headers.host}`;

    // Get Torrentio Manifest
    const tManifest = torrentioManifest({ ...parseConfiguration(configs), host });

    // Get Cyberflix Manifest
    let cManifest = { catalogs: [] };
    try {
        // Note: This might fail if the function isn't warm or during local dev if not handled
        // We use a timeout to prevent hanging the main manifest request
        const configsPath = configs ? `c/${encodeURIComponent(configs)}/` : '';
        const response = await axios.get(`${host}/${configsPath}catalog/manifest.json`, { timeout: 5000 }).catch(() => null);
        if (response && response.data) {
            cManifest = response.data;
        }
    } catch (e) {
        console.error('Failed to fetch Cyberflix manifest:', e.message);
    }

    const mergedManifest = {
        ...tManifest,
        id: 'brazuca.pandapal',
        name: 'PandaPal',
        description: 'Thomas is tired of all the others not working!',
        catalogs: [...(cManifest.catalogs || []), ...(tManifest.catalogs || [])],
        resources: ['stream', 'catalog', 'meta'],
        types: ['movie', 'series', 'anime', 'other'],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    // Ensure background and logo use the host
    mergedManifest.logo = `${host}/catalog/web/assets/assets/logo.png`;
    mergedManifest.background = `${host}/catalog/web/assets/assets/bg_image.jpeg`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(mergedManifest));
}
