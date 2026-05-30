const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Create CSS bundle placeholder
const cssDir = path.join(root, 'out', 'vs', 'workbench');
fs.mkdirSync(cssDir, { recursive: true });
fs.writeFileSync(
    path.join(cssDir, 'workbench.web.main.css'),
    'body { background-color: #1e1e1e; color: #cccccc; margin: 0; padding: 0; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }'
);
console.log('Created: out/vs/workbench/workbench.web.main.css');

// Create manifest.json if missing
const manifestDir = path.join(root, 'resources', 'server');
fs.mkdirSync(manifestDir, { recursive: true });
const manifestPath = path.join(manifestDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
        name: 'Void Editor',
        short_name: 'Void',
        start_url: '.',
        display: 'standalone',
        background_color: '#1e1e1e',
        theme_color: '#1e1e1e'
    }));
    console.log('Created: resources/server/manifest.json');
} else {
    console.log('Skipped: resources/server/manifest.json (already exists)');
}

console.log('Done!');
