const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', '@vscode', 'test-web', 'out', 'server', 'app.js');

if (fs.existsSync(targetFile)) {
    let content = fs.readFileSync(targetFile, 'utf8');
    let patched = false;

    // Patch 1: Allow all CORS origins (fixes Codespaces CORS)
    if (!content.includes('return origin; // Allow all origins to fix Codespaces CORS')) {
        content = content.replace(
            /return undefined;\r?\n\s*\},/g,
            "return origin; // Allow all origins to fix Codespaces CORS\n        },"
        );
        patched = true;
    }

    // Patch 2: Trust X-Forwarded-Host so URLs use the Codespaces domain
    if (!content.includes('app.proxy = true;')) {
        content = content.replace(
            /const app = new Koa\(\);/,
            "const app = new Koa();\n    app.proxy = true; // Trust X-Forwarded-Host from Codespaces"
        );
        patched = true;
    }

    // Patch 3: Force correct MIME types (fixes Codespaces proxy stripping Content-Type)
    if (!content.includes('Force correct MIME types')) {
        const mimeMiddleware = `
    // Force correct MIME types (fixes GitHub Codespaces proxy stripping Content-Type)
    const mimeTypes = { '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json' };
    app.use(async (ctx, next) => {
        await next();
        if (ctx.status === 200 || ctx.status === 304) {
            const ext = path_1.extname(ctx.path);
            if (mimeTypes[ext]) {
                ctx.type = mimeTypes[ext];
            }
        }
    });`;
        // Insert right before the serveOptions line
        content = content.replace(
            /(\s*const serveOptions = \{ hidden: true \};)/,
            mimeMiddleware + '\n$1'
        );
        // Ensure path_1 is available (it's already imported, but let's make sure extname is used properly)
        // path_1 is already imported as: const path_1 = require("path");
        patched = true;
    }

    if (patched) {
        fs.writeFileSync(targetFile, content);
        console.log('\x1b[34m[patch-cors]\x1b[0m Successfully patched @vscode/test-web for GitHub Codespaces.');
    } else {
        console.log('\x1b[34m[patch-cors]\x1b[0m @vscode/test-web is already patched.');
    }
} else {
    console.log('\x1b[33m[patch-cors]\x1b[0m Could not find @vscode/test-web server app.js. Skipping patch.');
}
