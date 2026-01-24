/**
 * Cardigann YAML Parser
 *
 * Parses Prowlarr/Jackett YAML indexer definitions into executable configs.
 * Handles the Cardigann v11 schema format.
 */

/**
 * Simple YAML parser for Cardigann definitions
 * (Avoids adding js-yaml dependency - handles the specific format we need)
 */
export function parseCardigannYaml(yamlContent) {
    const lines = yamlContent.split('\n');
    const result = {
        id: null,
        name: null,
        description: null,
        language: 'en-US',
        type: 'public',
        encoding: 'UTF-8',
        links: [],
        legacylinks: [],
        caps: {
            categorymappings: [],
            modes: {}
        },
        settings: [],
        search: {
            paths: [],
            inputs: {},
            rows: {},
            fields: {}
        }
    };

    let currentSection = null;
    let currentSubSection = null;
    let currentArray = null;
    let indentStack = [{ level: 0, obj: result }];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip empty lines and comments
        if (!line.trim() || line.trim().startsWith('#')) continue;

        // Calculate indent level
        const indent = line.search(/\S/);
        const content = line.trim();

        // Handle array items
        if (content.startsWith('- ')) {
            const value = content.substring(2).trim();

            // Simple array item (like links)
            if (currentArray && !value.includes(':')) {
                currentArray.push(value);
                continue;
            }
        }

        // Handle key: value pairs
        const colonIndex = content.indexOf(':');
        if (colonIndex > 0) {
            const key = content.substring(0, colonIndex).trim();
            let value = content.substring(colonIndex + 1).trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            // Top-level keys
            if (indent === 0) {
                currentSection = key;
                currentSubSection = null;
                currentArray = null;

                if (value) {
                    result[key] = value;
                } else if (key === 'links' || key === 'legacylinks') {
                    currentArray = result[key];
                }
                continue;
            }

            // Section-specific parsing
            switch (currentSection) {
                case 'links':
                case 'legacylinks':
                    // Already handled as array
                    break;

                case 'caps':
                    if (key === 'modes') {
                        result.caps.modes = parseModesLine(lines, i);
                    }
                    break;

                case 'search':
                    if (indent === 2) {
                        currentSubSection = key;
                        if (key === 'paths') {
                            result.search.paths = parseSearchPaths(lines, i);
                        } else if (key === 'inputs') {
                            result.search.inputs = parseInputs(lines, i);
                        } else if (key === 'rows') {
                            result.search.rows = parseRowSelector(lines, i);
                        } else if (key === 'fields') {
                            result.search.fields = parseFields(lines, i);
                        }
                    }
                    break;
            }
        }
    }

    return result;
}

/**
 * Parse search paths section
 */
function parseSearchPaths(lines, startIndex) {
    const paths = [];
    let i = startIndex + 1;

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || line.search(/\S/) <= 2) {
            if (line.search(/\S/) === 0 && line.trim() && !line.trim().startsWith('#')) break;
        }

        const content = line.trim();
        if (content.startsWith('- path:')) {
            paths.push({
                path: content.replace('- path:', '').trim()
            });
        } else if (content.startsWith('path:') && paths.length === 0) {
            paths.push({ path: content.replace('path:', '').trim() });
        }
        i++;
    }

    return paths;
}

/**
 * Parse inputs section
 */
function parseInputs(lines, startIndex) {
    const inputs = {};
    let i = startIndex + 1;

    while (i < lines.length) {
        const line = lines[i];
        const indent = line.search(/\S/);

        if (indent <= 4 && line.trim() && !line.trim().startsWith('#')) {
            if (indent <= 2) break;
        }

        const content = line.trim();
        const colonIndex = content.indexOf(':');
        if (colonIndex > 0 && indent >= 4) {
            const key = content.substring(0, colonIndex).trim();
            let value = content.substring(colonIndex + 1).trim();

            // Handle template variables
            if (value.startsWith('{{') || value.startsWith('"{{')) {
                // Keep as template
                inputs[key] = value.replace(/"/g, '');
            } else if (value) {
                inputs[key] = value;
            }
        }
        i++;
    }

    return inputs;
}

/**
 * Parse row selector
 */
function parseRowSelector(lines, startIndex) {
    const rows = { selector: null, filters: [] };
    let i = startIndex + 1;

    while (i < lines.length) {
        const line = lines[i];
        const indent = line.search(/\S/);

        if (indent <= 2 && line.trim() && !line.trim().startsWith('#')) break;

        const content = line.trim();
        if (content.startsWith('selector:')) {
            rows.selector = content.replace('selector:', '').trim();
        }
        i++;
    }

    return rows;
}

/**
 * Parse fields section
 */
function parseFields(lines, startIndex) {
    const fields = {};
    let i = startIndex + 1;
    let currentField = null;

    while (i < lines.length) {
        const line = lines[i];
        const indent = line.search(/\S/);

        if (indent <= 2 && line.trim() && !line.trim().startsWith('#')) break;

        const content = line.trim();

        // Field name
        if (indent === 4 && content.endsWith(':') && !content.startsWith('-')) {
            currentField = content.slice(0, -1);
            fields[currentField] = {};
        }
        // Field property
        else if (indent >= 6 && currentField) {
            const colonIndex = content.indexOf(':');
            if (colonIndex > 0) {
                const key = content.substring(0, colonIndex).trim();
                let value = content.substring(colonIndex + 1).trim();

                // Remove quotes
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }

                fields[currentField][key] = value;
            }
        }

        i++;
    }

    return fields;
}

/**
 * Parse modes line
 */
function parseModesLine(lines, startIndex) {
    const modes = {};
    let i = startIndex;

    while (i < lines.length) {
        const line = lines[i];
        const content = line.trim();

        if (content.includes('search:')) {
            modes.search = content.includes('[') ?
                content.match(/\[(.*?)\]/)?.[1]?.split(',').map(s => s.trim()) : ['q'];
        }
        if (content.includes('tv-search:')) {
            modes['tv-search'] = content.includes('[') ?
                content.match(/\[(.*?)\]/)?.[1]?.split(',').map(s => s.trim()) : ['q'];
        }
        if (content.includes('movie-search:')) {
            modes['movie-search'] = content.includes('[') ?
                content.match(/\[(.*?)\]/)?.[1]?.split(',').map(s => s.trim()) : ['q'];
        }

        if (line.search(/\S/) === 0 && !content.startsWith('#') && i > startIndex) break;
        i++;
    }

    return modes;
}

/**
 * Extract domains from parsed definition
 */
export function extractDomains(definition) {
    return [...(definition.links || []), ...(definition.legacylinks || [])];
}

/**
 * Extract search configuration
 */
export function extractSearchConfig(definition) {
    return {
        paths: definition.search?.paths || [],
        inputs: definition.search?.inputs || {},
        rowSelector: definition.search?.rows?.selector,
        fields: definition.search?.fields || {}
    };
}

export default { parseCardigannYaml, extractDomains, extractSearchConfig };
