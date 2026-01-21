import { manifest as torrentioManifest } from '../scraper/lib/manifest.js';
import { parseConfiguration } from '../scraper/lib/configuration.js';
import landingTemplate from '../scraper/lib/landingTemplate.js';

export default async function (req, res) {
    const configs = req.query.configs || '';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = `${protocol}://${req.headers.host}`;

    // Construct the manifest for the landing page
    const tManifest = torrentioManifest({ ...parseConfiguration(configs), host });

    const mergedManifest = {
        ...tManifest,
        id: 'brazuca.pandapal',
        name: 'PandaPal',
        description: 'The ultimate Stremio addon: Cyberflix Catalogs + Torrentio Streams.',
        version: '1.0.0',
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    // Ensure background and logo use the host
    mergedManifest.logo = `${host}/catalog/web/assets/assets/logo.png`;
    mergedManifest.background = `${host}/catalog/web/assets/assets/bg_image.jpeg`;

    // Render the landing template
    const html = landingTemplate(mergedManifest, parseConfiguration(configs) || {});

    // Inject some extra info about Cyberflix
    let modifiedHtml = html.replace('This addon has more :', 'This addon provides Cyberflix Catalogs and Torrentio Streams:');

    // Add a link to the Cyberflix-specific UI for catalog configuration
    const cyberflixLink = `<div>
    <p style="text-align: center; margin-top: 20px;">
      Want to configure specific catalogs? 
      <a href="/cyberflix-ui" style="color: #8A5AAB; font-weight: bold;">Use the Cyberflix UI</a>
    </p>
  </div>`;

    modifiedHtml = modifiedHtml.replace('</a>', '</a>' + cyberflixLink);

    res.setHeader('Content-Type', 'text/html');
    res.end(modifiedHtml);
}
