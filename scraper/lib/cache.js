import KeyvPostgres from "@keyv/postgres";
import { KeyvCacheableMemory } from "cacheable";
import { isStaticUrl } from '../moch/static.js';

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = 24 * 60 * 60 * 1000; // 24 hours
const STREAM_EMPTY_TTL = 60 * 1000; // 1 minute
const RESOLVED_URL_TTL = 3 * 60 * 60 * 1000; // 3 hours
const AVAILABILITY_TTL = 5 * 24 * 60 * 60 * 1000; // 5 days
const MESSAGE_VIDEO_URL_TTL = 60 * 1000; // 1 minutes
// When the streams are empty we want to cache it for less time in case of timeouts or failures

const DATABASE_URI = process.env.DATABASE_URI;

const memoryCache = new KeyvCacheableMemory({ ttl: MESSAGE_VIDEO_URL_TTL, lruSize: Infinity });

let remoteCache;
try {
  if (DATABASE_URI && (DATABASE_URI.startsWith('postgres') || DATABASE_URI.startsWith('postgresql'))) {
    if (DATABASE_URI.includes('127.0.0.1') || DATABASE_URI.includes('localhost')) {
      console.warn('Cache: DATABASE_URI points to localhost. Skipping remote cache to prevent ECONNREFUSED.');
    } else {
      // KeyvPostgres sometimes (depending on version) prefers postgresql:// over postgres://
      const normalizedUri = DATABASE_URI.replace(/^postgres:\/\//, 'postgresql://');

      remoteCache = new KeyvPostgres(normalizedUri, {
        table: 'torrentio_addon_cache',
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      });

      // Attach error handler to prevent unhandled rejection crashes from the underlying pool
      remoteCache.on('error', (err) => {
        console.error('KeyvPostgres Background Error:', err);
        // If fatal, we might want to kill remoteCache, but for now just logging prevents the crash
      });
    }
  }
} catch (e) {
  console.error('Cache: Failed to initialize remote cache:', e);
  remoteCache = null;
}


async function cacheWrap(cache, key, method, ttl) {
  if (!cache) {
    return method();
  }
  const value = await cache.get(key);
  if (value !== undefined) {
    return value;
  }
  const result = await method();
  const ttlValue = ttl instanceof Function ? ttl(result) : ttl;
  await cache.set(key, result, ttlValue);
  return result;
}

export function cacheWrapStream(id, method) {
  const ttl = (streams) => streams.length ? STREAM_TTL : STREAM_EMPTY_TTL;
  return cacheWrap(remoteCache, `${STREAM_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrap(remoteCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheAvailabilityResults(infoHash, fileIds) {
  if (!remoteCache) return Promise.resolve();
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  const containsFileIds = (array) => array.some(ids => ids.toString() === fileIdsString)
  return remoteCache.get(key)
    .then(result => {
      const newResult = result || [];
      if (!containsFileIds(newResult)) {
        newResult.push(fileIds);
        newResult.sort((a, b) => b.length - a.length);
      }
      return remoteCache.set(key, newResult, AVAILABILITY_TTL);
    });
}

export function removeAvailabilityResults(infoHash, fileIds) {
  if (!remoteCache) return Promise.resolve();
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  return remoteCache.get(key)
    .then(result => {
      const storedIndex = result?.findIndex(ids => ids.toString() === fileIdsString);
      if (storedIndex >= 0) {
        result.splice(storedIndex, 1);
        return remoteCache.set(key, result, AVAILABILITY_TTL);
      }
    });
}

export function getCachedAvailabilityResults(infoHashes) {
  if (!remoteCache) return Promise.resolve({});
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  return remoteCache.getMany(keys)
    .then(result => {
      const availabilityResults = {};
      infoHashes.forEach((infoHash, index) => {
        if (result[index]) {
          availabilityResults[infoHash] = result[index];
        }
      });
      return availabilityResults;
    })
    .catch(error => {
      console.log('Failed retrieve availability cache', error)
      return {};
    });
}

export function cacheMochAvailabilityResult(moch, infoHash, result = { cached: true }) {
  if (!remoteCache) return Promise.resolve();
  const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
  return remoteCache.set(key, result, AVAILABILITY_TTL);
}

export function removeMochAvailabilityResult(moch, infoHash) {
  if (!remoteCache) return Promise.resolve();
  const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
  return remoteCache.delete(key);
}

export function getMochCachedAvailabilityResults(moch, infoHashes) {
  if (!remoteCache) return Promise.resolve({});
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`)
  return remoteCache.getMany(keys)
    .then(result => {
      const availabilityResults = {};
      infoHashes.forEach((infoHash, index) => {
        if (result[index]) {
          availabilityResults[infoHash] = result[index];
        }
      });
      return availabilityResults;
    })
    .catch(error => {
      console.log('Failed retrieve availability cache', error)
      return {};
    });
}
