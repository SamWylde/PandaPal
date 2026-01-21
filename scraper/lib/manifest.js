import { MochOptions } from '../moch/moch.js';
import { Providers } from './filter.js';
import { showDebridCatalog } from '../moch/options.js';
import { getManifestOverride } from './configuration.js';
import { Type } from './types.js';

const DefaultProviders = Providers.options.map(provider => provider.key);
const MochProviders = Object.values(MochOptions);

export function manifest(config = {}) {
  const overrideManifest = getManifestOverride(config);
  const baseManifest = {
    id: 'com.stremio.pandapal.addon',
    version: '0.0.15',
    name: getName(overrideManifest, config),
    description: getDescription(config),
    catalogs: getCatalogs(config),
    resources: getResources(config),
    types: [Type.MOVIE, Type.SERIES, Type.ANIME, Type.OTHER],
    background: `${config.host}/catalog/web/assets/assets/bg_image.jpeg`,
    logo: `${config.host}/catalog/web/assets/assets/logo.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
  return Object.assign(baseManifest, overrideManifest);
}

export function dummyManifest() {
  const manifestDefault = manifest();
  manifestDefault.catalogs = [{ id: 'dummy', type: Type.OTHER }];
  manifestDefault.resources = ['stream', 'meta'];
  return manifestDefault;
}

function getName(manifest, config) {
  const rootName = manifest?.name || 'PandaPal';
  const mochSuffix = MochProviders
    .filter(moch => config[moch.key])
    .map(moch => moch.shortName)
    .join('/');
  return [rootName, mochSuffix].filter(v => v).join(' ');
}

function getDescription(config) {
  const providersList = config[Providers.key] || DefaultProviders;
  const enabledProvidersDesc = Providers.options
    .map(provider => `${provider.label}${providersList.includes(provider.key) ? '(+)' : '(-)'}`)
    .join(', ')
  const enabledMochs = MochProviders
    .filter(moch => config[moch.key])
    .map(moch => moch.name)
    .join(' & ');
  const possibleMochs = MochProviders.map(moch => moch.name).join('/')
  const mochsDesc = enabledMochs ? ` and ${enabledMochs} enabled` : '';
  return 'The ultimate Stremio addon: Cyberflix Catalogs + Torrentio Streams.'
    + ` Currently supports ${enabledProvidersDesc}${mochsDesc}.`
    + ` To configure providers, ${possibleMochs} support and other settings visit the PandaPal configuration page.`
}

function getCatalogs(config) {
  return MochProviders
    .filter(moch => showDebridCatalog(config) && config[moch.key])
    .map(moch => moch.catalogs.map(catalogName => ({
      id: catalogName ? `torrentio-${moch.key}-${catalogName.toLowerCase()}` : `torrentio-${moch.key}`,
      name: catalogName ? `${moch.name} ${catalogName}` : `${moch.name}`,
      type: 'other',
      extra: [{ name: 'skip' }],
    })))
    .reduce((a, b) => a.concat(b), []);
}

function getResources(config) {
  const streamResource = {
    name: 'stream',
    types: [Type.MOVIE, Type.SERIES, Type.ANIME],
    idPrefixes: ['tt', 'kitsu']
  };
  const metaResource = {
    name: 'meta',
    types: [Type.OTHER],
    idPrefixes: MochProviders.filter(moch => config[moch.key]).map(moch => moch.key)
  };
  if (showDebridCatalog(config) && MochProviders.filter(moch => config[moch.key]).length) {
    return [streamResource, metaResource];
  }
  return [streamResource];
}
