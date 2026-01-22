
/**
 * Safely parses and encodes a PostgreSQL connection URI.
 * Handles passwords containing special characters like '@' by finding the last separator.
 * 
 * @param {string} uri - The raw connection URI
 * @returns {string} The normalized URI with encoded credentials, or the original URI if parsing fails
 */
export function normalizePostgresUri(uri) {
    if (!uri || typeof uri !== 'string') return uri;

    // If it doesn't look like a postgres URI, return as is
    if (!uri.startsWith('postgres://') && !uri.startsWith('postgresql://')) {
        return uri;
    }

    try {
        // 1. Strip protocol temporarily
        let protocol = 'postgres://';
        let content = uri;

        if (uri.startsWith('postgres://')) {
            content = uri.substring(11);
        } else if (uri.startsWith('postgresql://')) {
            protocol = 'postgresql://';
            content = uri.substring(13);
        }

        // 2. Find the LAST '@' symbol. This separates user:pass from host:port/db
        const lastAtIndex = content.lastIndexOf('@');
        if (lastAtIndex === -1) {
            // No auth info, or malformed. Return as is.
            return uri;
        }

        const authPart = content.substring(0, lastAtIndex);
        const hostPart = content.substring(lastAtIndex + 1);

        // 3. Split auth part into user and password by the FIRST ':'
        const firstColonIndex = authPart.indexOf(':');
        if (firstColonIndex === -1) {
            // No password provided? Return as is.
            return uri;
        }

        const user = authPart.substring(0, firstColonIndex);
        const password = authPart.substring(firstColonIndex + 1);

        // 4. Encode the password component
        const encodedPassword = encodeURIComponent(password);

        // 5. Reassemble
        return `${protocol}${user}:${encodedPassword}@${hostPart}`;
    } catch (err) {
        console.warn('Failed to normalize URI:', err);
        return uri;
    }
}
