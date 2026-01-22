/**
 * PandaPal Landing Page Template
 * 
 * Generates the HTML for the addon configuration page.
 * Uses helper functions for consistent form generation and links to external CSS/JS.
 */

import { Providers, QualityFilter, SizeFilter, ForceIncludeExcluded } from './filter.js';
import { SortOptions } from './sort.js';
import { LanguageOptions } from './languages.js';
import { DebridOptions } from '../moch/options.js';
import { MochOptions } from '../moch/moch.js';
import { PreConfigurations } from './configuration.js';

// ==========================================================================
// Cyberflix Catalog Definitions
// ==========================================================================

const CYBERFLIX_CATALOGS = [
   { id: 'premieres', name: 'Premieres' },
   { id: 'trending_today', name: 'Trending Today' },
   { id: 'trending', name: 'Trending This Week' },
   { id: 'blockbusters', name: 'Blockbusters' },
   { id: 'awards', name: 'Award Winners' },
   { id: 'netflix', name: 'Netflix' },
   { id: 'disney_plus', name: 'Disney+' },
   { id: 'hbo_max', name: 'HBO Max' },
   { id: 'amazon_prime', name: 'Amazon Prime' },
   { id: 'hulu', name: 'Hulu' },
   { id: 'anime', name: 'Anime' },
   { id: 'kids', name: 'Kids' }
];

// ==========================================================================
// HTML Helper Functions
// ==========================================================================

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
   if (!str) return '';
   return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

/**
 * Generate options HTML for select elements
 */
function generateOptions(options, valueKey = 'key', labelKey = 'label', selectedValue = null) {
   return options.map(option => {
      const value = option[valueKey];
      const label = option[labelKey] || option.name || option.description || value;
      const selected = selectedValue === value ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
   }).join('\n');
}

/**
 * Generate a form group with label, optional description, and input
 */
function formGroup(id, label, inputHtml, options = {}) {
   const { description, link } = options;

   const labelContent = link
      ? `${label} (<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.text)}</a>)`
      : label;

   const descriptionHtml = description
      ? `<p class="form-description" id="${id}-desc">${escapeHtml(description)}</p>`
      : '';

   return `
    <div class="form-group">
      <label class="form-label" for="${id}">${labelContent}</label>
      ${descriptionHtml}
      ${inputHtml}
    </div>
  `;
}

/**
 * Generate a text input
 */
function textInput(id, options = {}) {
   const { placeholder = '', type = 'text', pattern = '' } = options;
   const ariaDesc = options.description ? `aria-describedby="${id}-desc"` : '';
   const patternAttr = pattern ? `pattern="${escapeHtml(pattern)}"` : '';

   return `<input type="${type}" id="${id}" class="form-input" placeholder="${escapeHtml(placeholder)}" ${patternAttr} ${ariaDesc}>`;
}

/**
 * Generate a select input
 */
function selectInput(id, optionsHtml, options = {}) {
   const ariaDesc = options.description ? `aria-describedby="${id}-desc"` : '';

   return `
    <select id="${id}" class="form-input form-select" ${ariaDesc}>
      ${optionsHtml}
    </select>
  `;
}

/**
 * Generate a multiselect wrapper
 */
function multiselectInput(id, optionsHtml, options = {}) {
   const { emptyText = 'None' } = options;
   const ariaDesc = options.description ? `aria-describedby="${id}-desc"` : '';

   return `
    <div class="multiselect-wrapper">
      <select id="${id}" class="form-input" name="${id}[]" multiple="multiple" data-empty-text="${escapeHtml(emptyText)}" ${ariaDesc}>
        ${optionsHtml}
      </select>
    </div>
  `;
}

/**
 * Generate a checkbox group
 */
function checkboxGroup(id, label, description = '') {
   return `
    <div class="checkbox-group">
      <input type="checkbox" id="${id}" class="checkbox-input">
      <div>
        <label class="checkbox-label" for="${id}">${escapeHtml(label)}</label>
        ${description ? `<p class="checkbox-description">${escapeHtml(description)}</p>` : ''}
      </div>
    </div>
  `;
}

/**
 * Generate a form section with title
 */
function formSection(icon, title, content) {
   return `
    <fieldset class="form-section">
      <legend class="form-section-title"><span class="icon">${icon}</span> ${escapeHtml(title)}</legend>
      <div class="form-section-content">
        ${content}
      </div>
    </fieldset>
  `;
}

/**
 * Generate a conditional (debrid) section
 */
function conditionalSection(id, content) {
   return `
    <div id="${id}" class="conditional-section debrid-section">
      ${content}
    </div>
  `;
}

// ==========================================================================
// Main Template Function
// ==========================================================================

export default function landingTemplate(manifest, config = {}) {
   // Parse current configuration
   const providers = config[Providers.key] || Providers.options.map(p => p.key);
   const sort = config[SortOptions.key] || SortOptions.options.qualitySeeders.key;
   const languages = config[LanguageOptions.key] || [];
   const qualityFilters = config[QualityFilter.key] || [];
   const forceIncludeExcluded = config[ForceIncludeExcluded.key] === 'true';
   const sizeFilter = (config[SizeFilter.key] || []).join(',');
   const limit = config.limit || '';
   const catalogs = config.catalogs || CYBERFLIX_CATALOGS.map(c => c.id);
   const rpdb = config.rpdb || '';
   const trakt = config.trakt || '';

   // Debrid configuration
   const debridProvider = Object.keys(MochOptions).find(key => config[key]) || '';
   const debridOptions = config[DebridOptions.key] || [];
   const realDebridApiKey = config[MochOptions.realdebrid.key] || '';
   const premiumizeApiKey = config[MochOptions.premiumize.key] || '';
   const allDebridApiKey = config[MochOptions.alldebrid.key] || '';
   const debridLinkApiKey = config[MochOptions.debridlink.key] || '';
   const easyDebridApiKey = config[MochOptions.easydebrid.key] || '';
   const offcloudApiKey = config[MochOptions.offcloud.key] || '';
   const torboxApiKey = config[MochOptions.torbox.key] || '';
   const putioKey = config[MochOptions.putio.key] || '';
   const putioClientId = putioKey.replace(/@.*/, '');
   const putioToken = putioKey.replace(/.*@/, '');

   // Build HTML option strings
   const catalogsOptionsHtml = generateOptions(CYBERFLIX_CATALOGS, 'id', 'name');
   const providersOptionsHtml = Providers.options
      .map(p => `<option value="${p.key}">${p.foreign ? p.foreign + ' ' : ''}${p.label}</option>`)
      .join('\n');
   const sortOptionsHtml = generateOptions(Object.values(SortOptions.options), 'key', 'description', sort);
   const languagesOptionsHtml = generateOptions(LanguageOptions.options, 'key', 'label');
   const qualityOptionsHtml = generateOptions(Object.values(QualityFilter.options), 'key', 'label');
   const debridProvidersOptionsHtml = generateOptions(Object.values(MochOptions), 'key', 'name');
   const debridOptionsHtml = generateOptions(Object.values(DebridOptions.options), 'key', 'description');

   // Build JavaScript configuration object
   const jsConfig = {
      providers: { key: Providers.key, options: Providers.options },
      sortOptions: { key: SortOptions.key, options: SortOptions.options },
      qualityFilter: { key: QualityFilter.key },
      sizeFilter: { key: SizeFilter.key },
      forceIncludeExcluded: { key: ForceIncludeExcluded.key },
      languageOptions: { key: LanguageOptions.key },
      debridOptions: { key: DebridOptions.key },
      mochOptions: MochOptions,
      preConfigurations: Object.fromEntries(
         Object.entries(PreConfigurations).map(([k, v]) => [k, v.serialized])
      ),
      initialValues: {
         catalogs,
         providers,
         languages,
         qualityFilters,
         forceIncludeExcluded,
         sort,
         limit,
         sizeFilter,
         rpdb,
         trakt,
         debridProvider,
         debridOptions,
         realDebridApiKey,
         premiumizeApiKey,
         allDebridApiKey,
         debridLinkApiKey,
         easyDebridApiKey,
         offcloudApiKey,
         torboxApiKey,
         putioClientId,
         putioToken
      }
   };

   const background = manifest.background || 'https://dl.strem.io/addon-background.jpg';
   const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';

   // ==========================================================================
   // Build HTML Sections
   // ==========================================================================

   // Section 1: Catalog Settings
   const catalogSection = formSection('🎬', 'Catalog Settings', `
    ${formGroup('iCatalogs', 'Catalogs',
      multiselectInput('iCatalogs', catalogsOptionsHtml, { emptyText: 'All catalogs', description: true }),
      { description: 'Select which catalogs to display in Stremio.' }
   )}
    ${formGroup('iRpdb', 'RPDB API Key',
      textInput('iRpdb', { placeholder: 'Optional', description: true }),
      { description: 'For rated posters in catalog.', link: { url: 'https://ratingposterdb.com/api-key/', text: 'Get it here' } }
   )}
    ${formGroup('iTrakt', 'Trakt Client ID',
      textInput('iTrakt', { placeholder: 'Optional', description: true }),
      { description: 'For personalized recommendations.', link: { url: 'https://trakt.tv/oauth/applications', text: 'Get it here' } }
   )}
  `);

   // Section 2: Stream Sources
   const sourcesSection = formSection('🔍', 'Stream Sources', `
    ${formGroup('iProviders', 'Torrent Providers',
      multiselectInput('iProviders', providersOptionsHtml, { emptyText: 'All providers', description: true }),
      { description: 'Choose which torrent sites to scrape for streams.' }
   )}
  `);

   // Section 3: Quality & Filtering
   const filteringSection = formSection('⚙️', 'Quality & Filtering', `
    ${formGroup('iSort', 'Sorting',
      selectInput('iSort', sortOptionsHtml, { description: true }),
      { description: 'How streams are ordered in results.' }
   )}
    ${formGroup('iLanguages', 'Priority Language',
      multiselectInput('iLanguages', languagesOptionsHtml, { emptyText: 'None', description: true }),
      { description: 'Prefer streams with these dubs/subs.' }
   )}
    ${formGroup('iQualityFilter', 'Exclude Qualities',
      multiselectInput('iQualityFilter', qualityOptionsHtml, { emptyText: 'None', description: true }),
      { description: 'Hide streams with these quality levels.' }
   )}
    ${checkboxGroup('iForceIncludeExcluded',
      'Show excluded as fallback',
      'If all streams are filtered out, show excluded qualities instead of nothing.'
   )}
    ${formGroup('iLimit', 'Max Results Per Quality',
      textInput('iLimit', { placeholder: 'All results', pattern: '[0-9]*', description: true }),
      { description: 'Limit streams shown per resolution.' }
   )}
    <label class="form-label visually-hidden" id="iLimitLabel">Max results per quality:</label>
    ${formGroup('iSizeFilter', 'Video Size Limit',
      textInput('iSizeFilter', { placeholder: 'No limit', pattern: '([0-9.]*(?:MB|GB),?)+', description: true }),
      { description: 'Max file size (e.g., 5GB or 10GB,2GB for movies/series).' }
   )}
  `);

   // Section 4: Debrid Services
   const debridSection = formSection('💎', 'Debrid Services', `
    ${formGroup('iDebridProviders', 'Debrid Provider',
      selectInput('iDebridProviders', `<option value="none" selected>None</option>\n${debridProvidersOptionsHtml}`, { description: true }),
      { description: 'Link a premium service for faster streaming.' }
   )}
    
    ${conditionalSection('dRealDebrid',
      formGroup('iRealDebrid', 'RealDebrid API Key',
         textInput('iRealDebrid', { description: true }),
         { link: { url: 'https://real-debrid.com/apitoken', text: 'Find it here' } }
      )
   )}
    
    ${conditionalSection('dAllDebrid',
      formGroup('iAllDebrid', 'AllDebrid API Key',
         textInput('iAllDebrid', { description: true }),
         { link: { url: 'https://alldebrid.com/apikeys', text: 'Create it here' } }
      )
   )}
    
    ${conditionalSection('dPremiumize',
      formGroup('iPremiumize', 'Premiumize API Key',
         textInput('iPremiumize', { description: true }),
         { link: { url: 'https://www.premiumize.me/account', text: 'Find it here' } }
      )
   )}
    
    ${conditionalSection('dDebridlink',
      formGroup('iDebridLink', 'DebridLink API Key',
         textInput('iDebridLink', { description: true }),
         { link: { url: 'https://debrid-link.fr/webapp/apikey', text: 'Find it here' } }
      )
   )}
    
    ${conditionalSection('dEasydebrid',
      formGroup('iEasyDebrid', 'EasyDebrid API Key',
         textInput('iEasyDebrid', { description: true }),
         {}
      )
   )}
    
    ${conditionalSection('dOffcloud',
      formGroup('iOffcloud', 'Offcloud API Key',
         textInput('iOffcloud', { description: true }),
         { link: { url: 'https://offcloud.com/#/account', text: 'Find it here' } }
      )
   )}
    
    ${conditionalSection('dTorbox',
      formGroup('iTorbox', 'TorBox API Key',
         textInput('iTorbox', { description: true }),
         { link: { url: 'https://torbox.app/settings', text: 'Find it here' } }
      )
   )}
    
    ${conditionalSection('dPutio', `
      ${formGroup('iPutioClientId', 'Put.io Client ID',
      textInput('iPutioClientId', { placeholder: 'Client ID', description: true }),
      { link: { url: 'https://app.put.io/oauth', text: 'Create OAuth App here' } }
   )}
      ${formGroup('iPutioToken', 'Put.io Token',
      textInput('iPutioToken', { placeholder: 'Token' }),
      {}
   )}
    `)}
    
    ${conditionalSection('dDebridOptions',
      formGroup('iDebridOptions', 'Debrid Options',
         multiselectInput('iDebridOptions', debridOptionsHtml, { emptyText: 'None', description: true }),
         { description: 'Additional debrid service options.' }
      )
   )}
  `);

   // Install Section
   const installSection = `
    <div class="install-section">
      <a id="installLink" href="#" class="install-link">
        <button type="button" class="btn btn-primary">INSTALL</button>
      </a>
      <p class="install-hint">Click to install, or paste the link into Stremio search bar</p>
    </div>
  `;

   // ==========================================================================
   // Final HTML Output
   // ==========================================================================

   return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(manifest.name)} - Stremio Addon Configuration</title>
  <meta name="description" content="${escapeHtml(manifest.description || '')}">
  <link rel="shortcut icon" href="${escapeHtml(logo)}" type="image/x-icon">
  
  <!-- Fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  
  <!-- Vendor CSS -->
  <link href="/assets/vendor/bootstrap.min.css" rel="stylesheet">
  <link href="/assets/vendor/bootstrap-multiselect.css" rel="stylesheet">
  
  <!-- App CSS -->
  <link href="/static/css/configure.css" rel="stylesheet">
</head>
<body>
  <main class="config-container">
    <!-- Header -->
    <header class="config-header">
      <div class="config-logo">
        <img src="${escapeHtml(logo)}" alt="${escapeHtml(manifest.name)} logo">
      </div>
      <h1 class="config-title">
        ${escapeHtml(manifest.name)}
        <span class="config-version">v${escapeHtml(manifest.version || '0.0.0')}</span>
      </h1>
      <p class="config-description">${escapeHtml(manifest.description || '')}</p>
    </header>
    
    <!-- Configuration Form -->
    <form id="configForm" onsubmit="return false;">
      ${catalogSection}
      ${sourcesSection}
      ${filteringSection}
      ${debridSection}
      ${installSection}
    </form>
  </main>
  
  <!-- Vendor JS -->
  <script src="/assets/vendor/jquery.min.js"></script>
  <script src="/assets/vendor/popper.min.js"></script>
  <script src="/assets/vendor/bootstrap.min.js"></script>
  <script src="/assets/vendor/bootstrap-multiselect.min.js"></script>
  
  <!-- Configuration Data -->
  <script>
    window.PANDAPAL_CONFIG = ${JSON.stringify(jsConfig)};
  </script>
  
  <!-- App JS -->
  <script src="/static/js/configure.js"></script>
</body>
</html>`;
}
