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

const memoryCache = new KeyvCacheableMemory({ ttl: MESSAGE_VIDEO_URL_TTL, lruSize: Infinity });

// Remove remoteCache as direct DB connection is no longer supported for caching
const remoteCache = null;

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
  return cacheWrap(memoryCache, `${STREAM_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrap(memoryCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheAvailabilityResults(infoHash, fileIds) {
  // Use memory cache for availability results
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  const containsFileIds = (array) => array.some(ids => ids.toString() === fileIdsString)
  return memoryCache.get(key)
    .then(result => {
      const newResult = result || [];
      if (!containsFileIds(newResult)) {
        newResult.push(fileIds);
        newResult.sort((a, b) => b.length - a.length);
      }
      return memoryCache.set(key, newResult, AVAILABILITY_TTL);
    });
}

export function removeAvailabilityResults(infoHash, fileIds) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  return memoryCache.get(key)
    .then(result => {
      const storedIndex = result?.findIndex(ids => ids.toString() === fileIdsString);
      if (storedIndex >= 0) {
        result.splice(storedIndex, 1);
        return memoryCache.set(key, result, AVAILABILITY_TTL);
      }
    });
}

export function getCachedAvailabilityResults(infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  // KeyvCacheableMemory doesn't support getMany directly in the same way, but we can iterate
  return Promise.all(keys.map(key => memoryCache.get(key)))
    .then(results => {
      const availabilityResults = {};
      infoHashes.forEach((infoHash, index) => {
        if (results[index]) {
          availabilityResults[infoHash] = results[index];
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
  const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
  return memoryCache.set(key, result, AVAILABILITY_TTL);
}

export function removeMochAvailabilityResult(moch, infoHash) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
  return memoryCache.delete(key);
}

export function getMochCachedAvailabilityResults(moch, infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`)
  return Promise.all(keys.map(key => memoryCache.get(key)))
    .then(results => {
      const availabilityResults = {};
      infoHashes.forEach((infoHash, index) => {
        if (results[index]) {
          availabilityResults[infoHash] = results[index];
        }
      });
      return availabilityResults;
    })
    .catch(error => {
      console.log('Failed retrieve availability cache', error)
      return {};
    });
}
