/**
 * About/Documentation Page
 *
 * Public endpoint that lists all available API endpoints and their usage.
 */

export default function handler(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PandaPal API Documentation</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #e0e0e0;
            margin: 0;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 {
            color: #00d4ff;
            text-align: center;
            margin-bottom: 10px;
        }
        .subtitle {
            text-align: center;
            color: #888;
            margin-bottom: 40px;
        }
        .section {
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .section h2 {
            color: #00d4ff;
            margin-top: 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            padding-bottom: 10px;
        }
        .endpoint {
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            padding: 15px;
            margin: 15px 0;
        }
        .method {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 12px;
            margin-right: 10px;
        }
        .get { background: #2ecc71; color: #000; }
        .post { background: #3498db; color: #fff; }
        .delete { background: #e74c3c; color: #fff; }
        .path {
            font-family: monospace;
            color: #ffd700;
            font-size: 14px;
        }
        .description {
            margin: 10px 0;
            color: #aaa;
        }
        .params {
            background: rgba(0,0,0,0.3);
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 13px;
            margin-top: 10px;
        }
        .param-name { color: #00d4ff; }
        .param-desc { color: #888; }
        code {
            background: rgba(0,0,0,0.3);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: monospace;
        }
        .example {
            background: rgba(0,212,255,0.1);
            border-left: 3px solid #00d4ff;
            padding: 10px;
            margin-top: 10px;
            font-family: monospace;
            font-size: 12px;
            overflow-x: auto;
        }
        .tag {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            margin-left: 10px;
        }
        .tag-cron { background: #9b59b6; }
        .tag-debug { background: #e67e22; }
        .tag-public { background: #2ecc71; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🐼 PandaPal API</h1>
        <p class="subtitle">Torrent Search Engine for Stremio</p>

        <div class="section">
            <h2>🔍 Diagnostic Endpoints</h2>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/api/test-indexer</span>
                <span class="tag tag-debug">Debug</span>
                <p class="description">Test a single indexer with a specific query.</p>
                <div class="params">
                    <div><span class="param-name">indexer</span> <span class="param-desc">- Indexer ID (e.g., yts, arabtorrents-com)</span></div>
                    <div><span class="param-name">query</span> <span class="param-desc">- Search query (e.g., One Fast Move)</span></div>
                    <div><span class="param-name">type</span> <span class="param-desc">- Content type: movie, series (default: movie)</span></div>
                    <div><span class="param-name">imdbId</span> <span class="param-desc">- Optional IMDB ID (e.g., tt21096576)</span></div>
                </div>
                <div class="example">
                    GET /api/test-indexer?indexer=yts&query=One+Fast+Move&type=movie
                </div>
            </div>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/api/test-all-indexers</span>
                <span class="tag tag-debug">Debug</span>
                <p class="description">Test ALL CF-free indexers at once. Returns categorized results: working, garbage, empty, errors.</p>
                <div class="params">
                    <div><span class="param-name">query</span> <span class="param-desc">- Search query (default: One Fast Move)</span></div>
                    <div><span class="param-name">type</span> <span class="param-desc">- Content type: movie, series (default: movie)</span></div>
                    <div><span class="param-name">imdbId</span> <span class="param-desc">- IMDB ID (default: tt21096576)</span></div>
                    <div><span class="param-name">limit</span> <span class="param-desc">- Max indexers to test (default: 50)</span></div>
                </div>
                <div class="example">
                    GET /api/test-all-indexers?query=One+Fast+Move&type=movie
                </div>
            </div>
        </div>

        <div class="section">
            <h2>🎬 Stremio Addon Endpoints</h2>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/manifest.json</span>
                <span class="tag tag-public">Public</span>
                <p class="description">Stremio addon manifest. Install URL for Stremio.</p>
            </div>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/stream/:type/:id.json</span>
                <span class="tag tag-public">Public</span>
                <p class="description">Stream handler - returns torrent results for a movie/series.</p>
                <div class="params">
                    <div><span class="param-name">:type</span> <span class="param-desc">- movie or series</span></div>
                    <div><span class="param-name">:id</span> <span class="param-desc">- IMDB ID (e.g., tt1375666) or tt1375666:1:1 for series</span></div>
                </div>
                <div class="example">
                    GET /stream/movie/tt21096576.json
                </div>
            </div>

            <div class="endpoint">
                <span class="method delete">DELETE</span>
                <span class="path">/cache/clear</span>
                <span class="tag tag-debug">Debug</span>
                <p class="description">Clear cached torrents for a specific IMDB/Kitsu ID.</p>
                <div class="params">
                    <div><span class="param-name">imdbId</span> <span class="param-desc">- IMDB ID to clear</span></div>
                    <div><span class="param-name">kitsuId</span> <span class="param-desc">- OR Kitsu ID to clear</span></div>
                </div>
                <div class="example">
                    DELETE /cache/clear?imdbId=tt21096576
                </div>
            </div>
        </div>

        <div class="section">
            <h2>⏰ Cron Jobs</h2>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/api/cron/health-check</span>
                <span class="tag tag-cron">Cron</span>
                <p class="description">Health check for all indexers. Updates indexer_health table with success rates, response times, and working domains.</p>
                <div class="params">
                    <div><span class="param-name">force</span> <span class="param-desc">- Set to "true" to bypass cron lock</span></div>
                </div>
            </div>

            <div class="endpoint">
                <span class="method get">GET</span>
                <span class="path">/api/cron/prowlarr-update</span>
                <span class="tag tag-cron">Cron</span>
                <p class="description">Sync indexer definitions from Prowlarr GitHub repo.</p>
            </div>
        </div>

        <div class="section">
            <h2>📊 Architecture Overview</h2>
            <ul>
                <li><strong>Real-time Search:</strong> Searches multiple indexers in parallel with health-prioritized ordering</li>
                <li><strong>CF-Free First:</strong> Prioritizes indexers that don't need Cloudflare bypass for speed</li>
                <li><strong>Title Relevance Filter:</strong> Removes garbage results that don't match the search query</li>
                <li><strong>Circuit Breaker:</strong> Auto-disables indexers after 5 consecutive failures</li>
                <li><strong>Cardigann Engine:</strong> Parses Prowlarr YAML definitions for 100+ indexers</li>
                <li><strong>FlareSolverr:</strong> Optional Cloudflare bypass for protected sites</li>
            </ul>
        </div>

        <div class="section">
            <h2>🔧 Configuration</h2>
            <p>Environment variables:</p>
            <ul>
                <li><code>SUPABASE_URL</code> - Supabase project URL</li>
                <li><code>SUPABASE_KEY</code> - Supabase anon key</li>
                <li><code>FLARESOLVERR_URL</code> - FlareSolverr endpoint (optional)</li>
                <li><code>REDIS_URL</code> - Redis URL for rate limiting (optional)</li>
            </ul>
        </div>
    </div>
</body>
</html>`;

    res.status(200).send(html);
}
