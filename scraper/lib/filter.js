import { extractProvider, parseSize, extractSize } from './titleHelper.js';
import { Type } from './types.js';
export const Providers = {
  key: 'providers',
  options: [
    {
      key: 'yts',
      label: 'YTS'
    },
    {
      key: 'eztv',
      label: 'EZTV'
    },
    {
      key: 'rarbg',
      label: 'RARBG'
    },
    {
      key: '1337x',
      label: '1337x'
    },
    {
      key: 'thepiratebay',
      label: 'ThePirateBay'
    },
    {
      key: 'kickasstorrents',
      label: 'KickassTorrents'
    },
    {
      key: 'torrentgalaxy',
      label: 'TorrentGalaxy'
    },
    {
      key: 'magnetdl',
      label: 'MagnetDL'
    },
    {
      key: 'horriblesubs',
      label: 'HorribleSubs',
      anime: true
    },
    {
      key: 'nyaasi',
      label: 'NyaaSi',
      anime: true
    },
    {
      key: 'tokyotosho',
      label: 'TokyoTosho',
      anime: true
    },
    {
      key: 'anidex',
      label: 'AniDex',
      anime: true
    },
    {
      key: 'rutor',
      label: 'Rutor',
      foreign: '🇷🇺'
    },
    {
      key: 'rutracker',
      label: 'Rutracker',
      foreign: '🇷🇺'
    },
    {
      key: 'comando',
      label: 'Comando',
      foreign: '🇵🇹'
    },
    {
      key: 'bludv',
      label: 'BluDV',
      foreign: '🇵🇹'
    },
    {
      key: 'micoleaodublado',
      label: 'MicoLeaoDublado',
      foreign: '🇵🇹'
    },
    {
      key: 'torrent9',
      label: 'Torrent9',
      foreign: '🇫🇷'
    },
    {
      key: 'ilcorsaronero',
      label: 'ilCorSaRoNeRo',
      foreign: '🇮🇹'
    },
    {
      key: 'mejortorrent',
      label: 'MejorTorrent',
      foreign: '🇪🇸'
    },
    {
      key: 'wolfmax4k',
      label: 'Wolfmax4k',
      foreign: '🇪🇸'
    },
    {
      key: 'cinecalidad',
      label: 'Cinecalidad',
      foreign: '🇲🇽'
    },
    {
      key: 'besttorrents',
      label: 'BestTorrents',
      foreign: '🇵🇱'
    },
  ]
};
export const QualityFilter = {
  key: 'qualityfilter',
  options: [
    {
      key: 'brremux',
// ... unchanged ...
  ]
};
export const ForceIncludeExcluded = {
  key: 'force_include_excluded'
};
export const SizeFilter = {
  key: 'sizefilter'
}
const defaultProviderKeys = Providers.options.map(provider => provider.key);

export default function applyFilters(streams, config) {
  return [
    filterByProvider,
    filterByQuality,
    filterBySize
  ].reduce((filteredStreams, filter) => filter(filteredStreams, config), streams);
}

// ... unchanged ...

function filterByQuality(streams, config) {
  const filters = config[QualityFilter.key];
  if (!filters) {
    return streams;
  }
  const filterOptions = QualityFilter.options.filter(option => filters.includes(option.key));
  const filtered = streams.filter(stream => {
    const streamQuality = stream.name.split('\n')[1];
    const bingeGroup = stream.behaviorHints?.bingeGroup;
    return !filterOptions.some(option => option.test(streamQuality, bingeGroup));
  });

  // Fallback: if enabled and all streams are filtered out, return the original list
  if (config[ForceIncludeExcluded.key] && filtered.length === 0 && streams.length > 0) {
    return streams;
  }
  return filtered;
}

function filterBySize(streams, config) {
  const sizeFilters = config[SizeFilter.key];
  if (!sizeFilters?.length) {
    return streams;
  }
  const sizeLimit = parseSize(config.type === Type.MOVIE ? sizeFilters.shift() : sizeFilters.pop());
  return streams.filter(stream => {
    const size = extractSize(stream.title)
    return size <= sizeLimit;
  })
}
