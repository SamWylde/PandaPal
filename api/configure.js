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
    description: 'Thomas is tired of all the others not working!',
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

  res.setHeader('Content-Type', 'text/html');
  res.end(html);

}
