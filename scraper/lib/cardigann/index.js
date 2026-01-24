/**
 * Cardigann Integration Module
 *
 * Integrates Prowlarr/Jackett YAML indexer definitions for automatic
 * domain updates and scraper configuration.
 *
 * Source: https://github.com/Prowlarr/Indexers
 */

export { CardigannEngine } from './engine.js';
export { DefinitionSync } from './sync.js';
export { searchWithCardigann, getAvailableIndexers } from './search.js';
