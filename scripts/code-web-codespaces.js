#!/usr/bin/env node
// @ts-check
/**
 * GitHub Codespaces wrapper for @vscode/test-web.
 * 
 * Starts the normal test-web server on an internal port, then runs a
 * lightweight HTTP reverse-proxy on the public port that fixes:
 *   1. CORS (allows all origins)
 *   2. MIME types (forces correct Content-Type based on file extension)
 *   3. Proxy trust (uses the real Codespaces hostname in generated URLs)
 *
 * Usage: node scripts/code-web-codespaces.js [--port 8080]
 */

const http = require('http');
const path = require('path');
const cp = require('child_process');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2), {
    string: ['port'],
    default: { port: '8080' }
});

const PUBLIC_PORT = parseInt(args.port, 10);
const INTERNAL_PORT = PUBLIC_PORT + 1; // test-web runs on this internally

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
};

// Step 1: Start the real test-web server on the internal port
console.log(`Starting @vscode/test-web on internal port ${INTERNAL_PORT}...`);

const APP_ROOT = path.join(__dirname, '..');
const testWebLocation = require.resolve('@vscode/test-web');

const child = cp.spawn(process.execPath, [
    testWebLocation,
    '--host', 'localhost',
    '--port', String(INTERNAL_PORT),
    '--browserType', 'none',
    '--sourcesPath', APP_ROOT,
    '--printServerLog'
], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => process.exit(code));
process.on('exit', () => child.kill());
process.on('SIGINT', () => { child.kill(); process.exit(0); });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });

// Step 2: Wait a moment for the server to start, then set up the proxy
setTimeout(() => {
    const proxy = http.createServer((req, res) => {
        // Set CORS headers on ALL responses
        const origin = req.headers['origin'] || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

        // Handle preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Forward the request to the internal server
        const proxyReq = http.request({
            hostname: 'localhost',
            port: INTERNAL_PORT,
            path: req.url,
            method: req.method,
            headers: {
                ...req.headers,
                host: `localhost:${INTERNAL_PORT}`,
            }
        }, (proxyRes) => {
            // Determine correct MIME type from file extension
            const urlPath = (req.url || '/').split('?')[0];
            const ext = path.extname(urlPath).toLowerCase();
            const correctMime = MIME_TYPES[ext];

            // Copy all headers from the upstream response
            const headers = { ...proxyRes.headers };

            // Override Content-Type if we know the correct one
            if (correctMime) {
                headers['content-type'] = correctMime;
            }

            // Re-apply CORS headers (in case upstream set different ones)
            headers['access-control-allow-origin'] = origin;
            headers['access-control-allow-credentials'] = 'true';
            headers['cross-origin-resource-policy'] = 'cross-origin';

            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('Proxy error:', err.message);
            res.writeHead(502);
            res.end('Bad Gateway - internal server not ready');
        });

        req.pipe(proxyReq);
    });

    proxy.listen(PUBLIC_PORT, '0.0.0.0', () => {
        console.log(`\n  🚀 Void (Codespaces Proxy) listening on http://0.0.0.0:${PUBLIC_PORT}`);
        console.log(`  Internal server on localhost:${INTERNAL_PORT}`);
        console.log(`  Open the forwarded port ${PUBLIC_PORT} in your browser.\n`);
    });

}, 2000);
