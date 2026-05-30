const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', '@vscode', 'test-web', 'out', 'server', 'app.js');

if (fs.existsSync(targetFile)) {
    let content = fs.readFileSync(targetFile, 'utf8');
    
    // Check if it's already patched
    if (!content.includes('return origin; // Allow all origins to fix Codespaces CORS')) {
        content = content.replace(
            /return undefined;\r?\n\s*\},/g,
            "return origin; // Allow all origins to fix Codespaces CORS\n        },"
        );

        // Also trust X-Forwarded-Host so URLs use the correct Codespaces domain instead of localhost:8080
        if (!content.includes('app.proxy = true;')) {
            content = content.replace(
                /const app = new Koa\(\);/,
                "const app = new Koa();\n    app.proxy = true; // Trust X-Forwarded-Host from Codespaces"
            );
        }

        fs.writeFileSync(targetFile, content);
        console.log('\x1b[34m[patch-cors]\x1b[0m Successfully patched @vscode/test-web to allow all CORS origins.');
    } else {
        console.log('\x1b[34m[patch-cors]\x1b[0m @vscode/test-web is already patched.');
    }
} else {
    console.log('\x1b[33m[patch-cors]\x1b[0m Could not find @vscode/test-web server app.js. Skipping patch.');
}
