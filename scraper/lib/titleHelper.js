export function extractSeeders(title) {
  const seedersMatch = title.match(/👤 (\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

export function extractSize(title) {
  const seedersMatch = title.match(/💾 ([\d.]+ \w+)/);
  return seedersMatch && parseSize(seedersMatch[1]) || 0;
}

export function extractProvider(title) {
  const match = title.match(/⚙.* ([^ \n]+)/);
  return match?.[1];
}

export function parseSize(sizeText) {
  if (!sizeText) {
    return 0;
  }
  let scale = 1;
  if (sizeText.includes('TB')) {
    scale = 1024 * 1024 * 1024 * 1024
  } else if (sizeText.includes('GB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('kB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText.replace(/,/g, '')) * scale);
}

export function extractResolution(title) {
  if (!title) return null;
  if (title.includes('2160p') || title.includes('4K')) return '4k';
  if (title.includes('1080p')) return '1080p';
  if (title.includes('720p')) return '720p';
  if (title.includes('480p')) return '480p';
  return null;
}
